import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
export const source = resolve(process.env.DSH_SOURCE ?? '../deepseek-harness')
export const adapterSource = resolve(
  process.env.DSH_NINFER_ADAPTER ?? fileURLToPath(new URL('../../dsh-llm-ninfer/', import.meta.url)),
)
const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')))
export const model = 'native-qualification-model'
export async function setup({
  baseURL,
  contextWindow = 150000,
  safetyMargin = 4096,
  contentReserve = 16384,
  credentialRef = 'NATIVE_TEST_KEY',
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-native-test-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-native-test-files-'))
  const profile = join(home, 'profiles/sdk')
  await mkdir(profile, { recursive: true })
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'native-test-sdk',
      private: true,
      dependencies: {},
      dsh: {
        profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'], patchReload: 'startup' },
      },
    }),
  )
  const recovery = resolve(fileURLToPath(new URL('..', import.meta.url)))
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    JSON.stringify([
      {
        insert: [
          {
            id: 'llm-ninfer',
            name: join(adapterSource, 'lib/index.js'),
            config: {
              provider: 'ninfer-local',
              baseURL,
              credentialRef,
              models: [{ id: model, contextWindow }],
              safetyMargin,
              contentReserve,
            },
          },
          {
            id: 'generation-recovery',
            name: join(recovery, 'lib/index.js'),
            config: { providers: ['ninfer-local'] },
          },
        ],
      },
      {
        id: 'compaction-basic',
        config: {
          modelPolicies: [
            {
              provider: 'ninfer-local',
              model,
              admission: 'prepared',
              targetRatio: 0.4,
              summarizationReasoningEffort: 'off',
              summarizationTools: false,
              maxTokens: 16384,
            },
          ],
        },
      },
    ]),
  )
  return { home, cwd }
}
export function client({ home, cwd }, options = {}) {
  return new DeepSeekHarness({
    dshBin: join(source, 'apps/cli/lib/bin.js'),
    dshHome: home,
    cwd,
    profile: 'sdk',
    provider: 'ninfer-local',
    model,
    reasoningEffort: 'off',
    ...options,
  })
}
export function ending(result) {
  return result.events.filter((e) => e.type === 'turn/end').at(-1)?.data.reason.kind
}
export async function record() {}
