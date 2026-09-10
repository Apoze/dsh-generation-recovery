/** Bounded generation recovery and exact-capacity admission on native agent extension points. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage, lastAssistantStreamChunk, LlmError } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

const configSchema = z
  .object({
    providers: z.array(z.string().min(1)).min(1),
    maxRetries: z.number().int().min(0).max(10).default(2),
    maxTotalAttempts: z.number().int().min(1).max(30).default(8),
    maxCapacityRecoveries: z.number().int().min(0).max(3).default(1),
  })
  .strict()
export type Config = z.input<typeof configSchema>
export const name = 'generation-recovery'
export const inject = ['agents']

function eventsForStep(agent: Agent, turn: number, step: number) {
  return agent.session
    .snapshotEvents()
    .filter((e) => 'turn' in e.data && 'step' in e.data && e.data.turn === turn && e.data.step === step)
}

export function apply(ctx: Context, config: Config): void {
  const settings = configSchema.parse(config)
  ctx.on('agent/pre-step', ({ agent, signal }, next) => {
    signal.throwIfAborted()
    const events = agent.session.snapshotEvents()
    const executedSteps = new Set(
      events
        .filter((event) => event.type === 'tool/call')
        .map((event) => `${event.data.turn}:${event.data.step}`),
    )
    for (const seq of [...agent.session.surface.nodes]) {
      const event = agent.session.eventAt(seq)
      if (
        event?.type !== 'assistant/message' ||
        event.data.message.source.kind !== 'model' ||
        !settings.providers.includes(event.data.message.source.provider) ||
        executedSteps.has(`${event.data.turn}:${event.data.step}`)
      )
        continue
      const terminal = lastAssistantStreamChunk(event.data.stream, 'finish')
      if (terminal?.reason.kind !== 'max-tokens') continue
      const notice = createUserMessage({
        content: [
          {
            type: 'text',
            text: `An earlier generation at session event ${seq} reached its output limit without executing a tool. Its incomplete output remains in the session log and is excluded from active context. Continue from completed actions; inspect actual files before deciding what remains.`,
          },
        ],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: 'Incomplete historical generation excluded from active context',
        },
      })
      agent.session.append('user/message', notice, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
    }
    return next()
  })
  ctx.on('agent/request-prepared', async ({ agent, turn, step, request, inspection, signal }, next) => {
    if (!settings.providers.includes(request.provider)) return next()
    if (!inspection)
      throw new LlmError('This route requires native request counting', 'NINFER_COUNT_UNAVAILABLE')
    const events = eventsForStep(agent, turn, step)
    const attempts = events.filter((e) => e.type === 'assistant/attempt').length
    if (attempts >= settings.maxTotalAttempts)
      throw new LlmError('Model attempt budget exhausted', 'GENERATION_RECOVERY_EXHAUSTED')
    const reserve = inspection.thinkingTokens + inspection.thinkingClosureTokens + inspection.contentReserve
    const required = Math.min(reserve, inspection.hardOutputCap ?? Infinity)
    const threshold = Math.min(
      inspection.compactionThreshold * inspection.contextWindow,
      inspection.contextWindow - required - inspection.safetyMargin,
    )
    if (inspection.inputTokens < threshold && inspection.maxOutputTokens > 0) return next()
    const before = agent.session.surface.replaceGeneration
    const counts = events.filter((e) => e.type === 'llm/request-inspected')
    const previous = counts.at(-2)
    if (
      previous?.type === 'llm/request-inspected' &&
      previous.data.inspection.inputTokens <= inspection.inputTokens
    ) {
      if (inspection.maxOutputTokens >= required && inspection.maxOutputTokens > 0) return next()
      throw new LlmError(
        'Context reduction did not restore usable output capacity',
        'CONTEXT_WINDOW_EXCEEDED',
      )
    }
    const capacityAttempts = agent.session
      .snapshotEvents()
      .filter((e) => e.type === 'compaction/start' && e.seq > (events[0]?.seq ?? 0)).length
    if (capacityAttempts >= settings.maxCapacityRecoveries) {
      if (inspection.maxOutputTokens >= required && inspection.maxOutputTokens > 0) return next()
      throw new LlmError('The request cannot fit with its required output budget', 'CONTEXT_WINDOW_EXCEEDED')
    }
    const compaction = ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction')
    if (!compaction)
      throw new LlmError(
        'This agent requires a compaction provider for native context admission',
        'NINFER_COMPACTION_UNAVAILABLE',
      )
    try {
      await compaction.compactIfNeeded(agent, 'context-overflow', signal)
    } catch (error) {
      signal.throwIfAborted()
      if (agent.session.surface.replaceGeneration > before) return { kind: 'retry' }
      if (inspection.maxOutputTokens >= required && inspection.maxOutputTokens > 0) return next()
      throw error
    }
    signal.throwIfAborted()
    if (agent.session.surface.replaceGeneration > before) return { kind: 'retry' }
    if (inspection.maxOutputTokens >= required && inspection.maxOutputTokens > 0) return next()
    throw new LlmError(
      'Fixed instructions or a retained input exceed usable context capacity',
      'CONTEXT_WINDOW_EXCEEDED',
    )
  })
  ctx.on('agent/response-incomplete', async ({ agent, turn, step, request, finish, signal }, next) => {
    if (!settings.providers.includes(request.provider)) return next()
    signal.throwIfAborted()
    const events = eventsForStep(agent, turn, step)
    const retries = events.filter((e) => e.type === 'agent/generation-recovery').length
    const attempts = events.filter((e) => e.type === 'assistant/attempt').length
    if (retries >= settings.maxRetries || attempts >= settings.maxTotalAttempts) return next()
    const invalid = finish.kind === 'error'
    if (invalid && retries > 0) return next()
    const prose = finish.kind === 'max-tokens' && finish.diagnostics?.toolStatus === 'absent'
    const text = prose
      ? 'The preceding answer reached the output limit. Produce a shorter, self-contained answer covering the essential requested information. Do not invent tool actions or claim that the incomplete answer was delivered in full.'
      : retries > 0
        ? 'The previous recovery also exceeded the output limit. Change the operation size again: create or edit only one short paragraph or one small function per tool call, then continue with further native edits until the task is complete. Re-read existing content when needed. No tool from the interrupted generation ran; preserve all previously completed work.'
        : invalid
          ? 'The preceding generation used invalid tool syntax and was rejected. No tool from that generation ran. Continue from the last completed action using the declared native tools and valid arguments.'
          : 'The preceding generation reached its output limit and was rejected. No tool from that generation ran. Continue the task autonomously from the last completed action. For a large file, write a small complete initial section, then extend it with targeted native edit operations, keeping each operation comfortably within the response budget. Preserve existing content and use read when needed. Do not repeat tools that already completed. Finish and verify the requested work before giving the final answer.'
    return {
      kind: 'retry',
      context: createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: 'Automatic recovery of an incomplete generation',
        },
      }),
    }
  })
}
