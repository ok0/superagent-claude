// Ported from dsh-superagent-prototype (MIT) tests/queue.spec.ts
/** Effect queue notices on the Runtime. Adapted from the reference queue spec: only the Router-session notice case (reference L28) is kept, since the reference L10 migration case is excluded by ADR-3. Worker notices are covered by tests/prompt-notice.spec.ts. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
let dir: string | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

it('keeps only the latest notice while the Router session cannot take one', async () => {
  dir = mkdtempSync(join(tmpdir(), 'queue-config-'))
  mkdirSync(join(dir, 'prompts', 'team'), { recursive: true })
  h = await startRuntime({ configDir: dir })
  await h.routerSessions()[0]!.close()
  h.breakRouter(1000)
  writeFileSync(join(dir, 'prompts', 'team', 'communication.md'), 'Team rule A')
  h.runtime.refreshPrompts()
  await h.idle()
  writeFileSync(join(dir, 'prompts', 'team', 'communication.md'), 'Team rule B')
  h.runtime.refreshPrompts()
  await h.idle()
  const notices = h.runtime.store.db.prepare("SELECT key, value FROM effect WHERE kind = 'notice'").all() as { key: string; value: string }[]
  expect(notices).toHaveLength(1)
  expect(notices[0]!.key).toBe('router-prompts')
  expect(notices[0]!.value).toContain('Team rule B')
  expect(notices[0]!.value).not.toContain('Team rule A')
  h.breakRouter(0)
  h.advance(70_000)
  h.runtime.effects.kick()
  await h.idle()
  const sent = h.routerSessions().at(-1)!.sent.filter(input => input.mode === 'inject').map(input => input.text)
  expect(sent.some(text => text.includes('Team rule B'))).toBe(true)
  expect(sent.some(text => text.includes('Team rule A'))).toBe(false)
  expect(h.runtime.effects.pending('notice')).toBe(false)
})
