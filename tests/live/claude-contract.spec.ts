/** Live Claude contract cases against the real SDK, gated by SUPERAGENT_CLAUDE_LIVE=1 and an auth mode; skipped otherwise. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe } from 'vitest'
import type { AgentRuntime } from '../../src/executor/contract.ts'
import type { AuthMode } from '../../src/runtimes/claude/options.ts'
import { ClaudeRuntime } from '../../src/runtimes/claude/runtime.ts'
import { sleep } from '../fixtures/async.ts'
import { runtimeContract, type ContractCase } from '../fixtures/runtime-contract.ts'

const LIVE = process.env.SUPERAGENT_CLAUDE_LIVE === '1'
const mode: AuthMode | undefined =
  (process.env.SUPERAGENT_CLAUDE_LIVE_AUTH as AuthMode | undefined) ??
  (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription' : process.env.ANTHROPIC_API_KEY ? 'api-key' : undefined)
const model = process.env.SUPERAGENT_CLAUDE_LIVE_MODEL ?? 'haiku'

const LIVE_CASES: ContractCase[] = [
  'steer joins the running turn',
  'steer in a running turn is reported read before the turn ends',
  'followup starts a new turn',
  'inject does not wake the session',
  'a tool call reaches the host',
  'a turn over the limit ends with a limit outcome',
]

describe.skipIf(!LIVE || !mode)('claude live contract', () => {
  runtimeContract(
    'claude',
    () => {
      const rt = new ClaudeRuntime({
        mode: mode!,
        configDir: mkdtempSync(join(tmpdir(), 'sac-live-')),
        env: process.env,
      })
      const wrapped: AgentRuntime = { id: rt.id, probe: () => rt.probe(), open: spec => rt.open({ ...spec, model }) }
      return wrapped
    },
    {
      cases: LIVE_CASES,
      timeoutMs: 180_000,
      quiet: async () => {
        await sleep(5_000)
      },
    },
  )
})
