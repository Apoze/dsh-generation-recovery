import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { setup, client, ending, record, model, source } from './support.mjs'

async function fixture(t, { input = 1000, respond }) {
  const generated = [],
    counts = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const native = {
      version: 1,
      instance_id: 'fixture-1',
      input_tokens: input,
      context_window: 150000,
      thinking_budget: 32768,
      thinking_closure_tokens: 4,
    }
    if (req.url.endsWith('/count_tokens')) {
      counts.push(body)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ...native, model }))
      return
    }
    generated.push(body)
    const result = respond(generated.length, body)
    if (result.error) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'Invalid native tool structure',
            type: 'server_error',
            code: 'invalid_model_output',
          },
        }),
      )
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (data) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'fixture-request-' + generated.length,
            object: 'chat.completion.chunk',
            created: 1,
            model,
            ...data,
          }) +
          '\n\n',
      )
    for (const delta of result.deltas ?? []) emit({ choices: [{ index: 0, delta, finish_reason: null }] })
    emit({
      choices: [
        { index: 0, delta: {}, finish_reason: result.limit ? 'length' : result.tool ? 'tool_calls' : 'stop' },
      ],
      ninfer: {
        ...native,
        cause: result.limit ? 'output_limit' : 'stop',
        tool_status: result.limit ? 'incomplete' : result.tool ? 'complete' : 'absent',
        effective_output_tokens: body.max_tokens,
        ...(result.limit ? { fragment: '<tool_call><function=write>truncated' } : {}),
      },
    })
    emit({ choices: [], usage: { prompt_tokens: input, completion_tokens: 10, total_tokens: input + 10 } })
    res.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = await setup({
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    credentialRef: 'NATIVE_TEST_KEY',
  })
  const harness = client(env, { env: { ...process.env, NATIVE_TEST_KEY: 'fixture-key' } })
  t.after(async () => {
    await harness.close()
    await new Promise((resolve) => server.close(resolve))
  })
  return { env, harness, generated, counts }
}
const write = (id, path, content) => ({
  tool_calls: [
    {
      index: 0,
      id,
      type: 'function',
      function: { name: 'write', arguments: JSON.stringify({ file_path: path, content }) },
    },
  ],
})

test('Loader, HTTP SDK and native write: interrupted mixed batch executes nothing, retry executes once', async (t) => {
  const f = await fixture(t, {
    respond: (n) =>
      n === 1
        ? { limit: true, deltas: [write('rejected', 'must-not-exist.txt', 'uncommitted')] }
        : n === 2
          ? { tool: true, deltas: [write('accepted', 'result.txt', 'réussi 🧪\n')] }
          : { deltas: [{ content: 'Done.' }] },
  })
  const result = await f.harness.run('Create result.txt, preserving completed work.')
  await record('fixture-mixed-batch', f.env, result)
  assert.equal(ending(result), 'completed')
  assert.equal(await readFile(join(f.env.cwd, 'result.txt'), 'utf8'), 'réussi 🧪\n')
  await assert.rejects(readFile(join(f.env.cwd, 'must-not-exist.txt')), { code: 'ENOENT' })
  assert.equal(result.events.filter((e) => e.type === 'tool/call').length, 1)
  assert.equal(f.generated.length, 3)
  assert.ok(!f.generated[1].messages.some((m) => m.tool_calls?.some((c) => c.id === 'rejected')))
  assert.deepEqual(f.counts[0].messages, f.generated[0].messages)
  assert.deepEqual(f.counts[0].tools, f.generated[0].tools)
})
test('an invalid native tool generation receives one corrective retry through the real loop', async (t) => {
  const f = await fixture(t, {
    respond: (n) => (n === 1 ? { error: true } : { deltas: [{ content: 'Corrected.' }] }),
  })
  const result = await f.harness.run('Answer concisely.')
  assert.equal(ending(result), 'completed')
  assert.equal(f.generated.length, 2)
  assert.equal(result.events.filter((e) => e.type === 'agent/generation-recovery').length, 1)
})
test('repeated output limits stop explicitly after three generations and never write', async (t) => {
  const f = await fixture(t, {
    respond: () => ({ limit: true, deltas: [write('rejected', 'never.txt', 'no')] }),
  })
  const result = await f.harness.run('Create never.txt.')
  assert.equal(ending(result), 'max-tokens')
  assert.equal(f.generated.length, 3)
  assert.equal(result.events.filter((e) => e.type === 'tool/call').length, 0)
  await assert.rejects(readFile(join(f.env.cwd, 'never.txt')), { code: 'ENOENT' })
})
test('60 percent context admits the actual remaining 55904 tokens, not ten percent', async (t) => {
  const f = await fixture(t, { input: 90000, respond: () => ({ deltas: [{ content: 'Enough room.' }] }) })
  const result = await f.harness.run('Answer.')
  assert.equal(ending(result), 'completed')
  assert.equal(f.generated[0].max_tokens, 55904)
  assert.equal(result.events.filter((e) => e.type === 'compaction/start').length, 0)
})
test('an indivisible request beyond context never reaches generation', async (t) => {
  const f = await fixture(t, { input: 149999, respond: () => ({ deltas: [{ content: 'Must not run' }] }) })
  const result = await f.harness.run('This request cannot fit.')
  assert.equal(ending(result), 'error')
  assert.equal(f.generated.length, 0)
})

test(
  'Python SDK sees a recovered generation as completed and retains all attempts',
  { skip: !process.env.DSH_TEST_PYTHON },
  async (t) => {
    const f = await fixture(t, {
      respond: (n) => (n === 1 ? { limit: true } : { deltas: [{ content: 'Recovered through Python.' }] }),
    })
    const script = `import json,sys
from deepseek_harness import DeepSeekHarness
with DeepSeekHarness(dsh_bin=sys.argv[1],dsh_home=sys.argv[2],cwd=sys.argv[3],provider='ninfer-local',model=sys.argv[4],reasoning_effort='off',env={'NATIVE_TEST_KEY':'fixture-key'}) as h:
 r=h.run('Answer briefly.')
 print(json.dumps({'finish':r.finish_reason,'attempts':sum(e['type']=='assistant/attempt' for e in r.events),'text':r.final_response}))
`
    let dshBin = join(source, 'apps/cli/lib/bin.js')
    if (process.platform === 'win32') {
      const shim = join(f.env.home, 'dsh.cmd')
      const quote = (value) => '"' + value.replaceAll('%', '%%') + '"'
      await writeFile(shim, '@' + quote(process.execPath) + ' ' + quote(dshBin) + ' %*\r\n')
      dshBin = shim
    }
    const { stdout } = await promisify(execFile)(
      process.env.DSH_TEST_PYTHON,
      ['-c', script, dshBin, f.env.home, f.env.cwd, model],
      { env: { ...process.env, PYTHONPATH: join(source, 'python/sdk/src') }, timeout: 60000 },
    )
    const result = JSON.parse(stdout)
    assert.equal(result.finish, 'completed')
    assert.equal(result.attempts, 1)
    assert.equal(result.text, 'Recovered through Python.')
  },
)
