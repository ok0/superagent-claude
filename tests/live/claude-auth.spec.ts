/** Live auth check: one followup turn per auth mode whose credential is set, gated by SUPERAGENT_CLAUDE_LIVE=1; never prints credential values. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '../../src/executor/contract.ts'
import { AUTH_ENV } from '../../src/runtimes/claude/options.ts'
import { ClaudeRuntime } from '../../src/runtimes/claude/runtime.ts'
import { waitUntil } from '../fixtures/async.ts'
import { contractSpec } from '../fixtures/runtime-contract.ts'

const LIVE = process.env.SUPERAGENT_CLAUDE_LIVE === '1'
const model = process.env.SUPERAGENT_CLAUDE_LIVE_MODEL ?? 'haiku'

describe.skipIf(!LIVE)('claude live auth', () => {
  for (const mode of ['api-key', 'subscription'] as const) {
    it.skipIf(!process.env[AUTH_ENV[mode][0]!])(
      `${mode} completes a turn`,
      async () => {
        const rt = new ClaudeRuntime({ mode, configDir: mkdtempSync(join(tmpdir(), 'sac-auth-')), env: process.env })
        const { spec } = contractSpec('followup starts a new turn', { model })
        const session = await rt.open(spec)
        const events: RuntimeEvent[] = []
        void (async () => {
          for await (const event of session.events()) events.push(event)
        })()
        session.send({ id: 'A', text: 'Reply with exactly OK.', mode: 'followup' })
        await waitUntil(() => events.some(event => event.type === 'turnEnded'), 180_000)
        const ended = events.find(event => event.type === 'turnEnded')
        expect(ended?.type === 'turnEnded' && ended.outcome).toBe('success')
        console.log(
          `[PAC13] mode=${mode} session=${session.sessionId} outcome=${ended?.type === 'turnEnded' ? ended.outcome : 'none'} costUsd=${ended?.type === 'turnEnded' ? ended.costUsd : 'none'}`,
        )
        await session.close()
      },
      180_000,
    )
  }
})
