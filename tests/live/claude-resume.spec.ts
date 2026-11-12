/**
 * Live Claude resume check against the real SDK: a resumed session recalls a fact from an earlier turn; gated like
 * claude-contract.spec.ts and skipped otherwise.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, RuntimeEvent } from '../../src/executor/contract.ts'
import type { AuthMode } from '../../src/runtimes/claude/options.ts'
import { ClaudeRuntime } from '../../src/runtimes/claude/runtime.ts'
import { waitUntil } from '../fixtures/async.ts'
import { contractSpec } from '../fixtures/runtime-contract.ts'

const LIVE = process.env.SUPERAGENT_CLAUDE_LIVE === '1'
const mode: AuthMode | undefined =
  (process.env.SUPERAGENT_CLAUDE_LIVE_AUTH as AuthMode | undefined) ??
  (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription' : process.env.ANTHROPIC_API_KEY ? 'api-key' : undefined)
const model = process.env.SUPERAGENT_CLAUDE_LIVE_MODEL ?? 'haiku'

function watch(session: AgentSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of session.events()) events.push(event)
  })()
  return events
}

const turnEnds = (events: RuntimeEvent[]) => events.filter(event => event.type === 'turnEnded')

describe.skipIf(!LIVE || !mode)('claude live resume', () => {
  it('a resumed session recalls what an earlier turn said', async () => {
    const rt = new ClaudeRuntime({
      mode: mode!,
      configDir: mkdtempSync(join(tmpdir(), 'sac-resume-')),
      env: process.env,
    })
    const first = contractSpec('a tool call reaches the host', {
      model,
      instructions: 'Follow the user message exactly.',
    })
    const s1 = await rt.open(first.spec)
    const events1 = watch(s1)
    s1.send({
      id: 'R1',
      text: 'Remember this code word for later: violet-kestrel-42. Reply with only OK.',
      mode: 'followup',
    })
    await waitUntil(() => turnEnds(events1).length >= 1, 180_000)
    expect(turnEnds(events1)[0]).toMatchObject({ outcome: 'success' })
    const id = s1.sessionId!
    await s1.close()

    const second = contractSpec('a tool call reaches the host', {
      model,
      instructions: 'Follow the user message exactly.',
      resume: id,
    })
    const s2 = await rt.open(second.spec)
    try {
      watch(s2)
      s2.send({
        id: 'R2',
        text: 'Call the report tool once with state ready and, as the summary, the code word I asked you to remember earlier.',
        mode: 'followup',
      })
      await waitUntil(() => second.reports.length > 0, 180_000)
      expect(s2.sessionId).toBe(id)
      expect(JSON.stringify(second.reports)).toContain('violet-kestrel-42')
      console.log(`[claude-resume] mode=${mode} session=${id} recalled=true`)
    } finally {
      await s2.close()
    }
  }, 300_000)
})
