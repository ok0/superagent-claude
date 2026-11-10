/**
 * Worker slots under load: at most the slot maximum runs at once, and a person's message wakes an idle ticket ahead of a waiting launch.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { accepted, guest, trigger } from './fixtures/engine.ts'
import { gates, workerHarness } from './fixtures/executor.ts'
import { waitUntil } from './fixtures/async.ts'

it('runs at most two of five tickets at once and finishes them all in turn', async () => {
  const g = gates()
  const w = workerHarness({ max: 2, script: ({ spec, index }) => index === 0 ? { hold: g.get(spec.key), tools: [{ name: 'report', args: { state: 'ready', summary: 'done' } }] } : {} })
  try {
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) {
      ids.push(accepted(w, String(i), `t${i}`).ticketId!)
      if (i < 5) w.tick(1)
    }
    await waitUntil(() => w.runtime.active === 2)
    await w.effects.idle('launch')
    expect(w.runtime.opened.length).toBe(2)
    for (let i = 0; i < 5; i++) {
      await waitUntil(() => w.runtime.opened.length > i)
      g.open(w.runtime.opened[i]!.key)
    }
    await waitUntil(() => ids.every(id => w.ticket(id).ended?.outcome === 'completed'))
    expect(w.runtime.maxActive).toBeLessThanOrEqual(2)
    expect(w.runtime.opened.length).toBe(5)
    expect(w.slots.used).toBe(0)
  } finally { await w.close() }
})

it("wakes an idle ticket for a person's message in the extra slot ahead of a waiting launch", async () => {
  const g = gates()
  const held = new Set<string>()
  let holdNext = false
  const w = workerHarness({
    max: 1,
    script: ({ spec, index }) => index === 0 && held.has(spec.key) ? { hold: g.get(spec.key) } : {},
    prepare: async ticket => {
      if (ticket.title && holdNext) held.add(`worker-${ticket.id}`)
      return { repository: 'owner/repo', cwd: join(tmpdir(), 'work', ticket.id), branch: `agent/${ticket.id}` }
    },
  })
  try {
    const a = accepted(w, '1', 'tA').ticketId!
    await waitUntil(() => !!w.runtime.sessions[0]?.closed)
    holdNext = true; held.add(`worker-${a}`)
    const b = accepted(w, '2', 'tB').ticketId!
    await waitUntil(() => w.runtime.active === 1 && w.runtime.opened.length === 2)
    holdNext = false
    const c = accepted(w, '3', 'tC').ticketId!
    await w.effects.idle('launch')
    expect(w.runtime.opened.length).toBe(2)
    w.engine.receive(trigger('4', { actor: guest, threads: [{ source: 'chat', id: 'tA' }] })); w.pump()
    await waitUntil(() => w.runtime.opened.length === 3)
    expect(w.runtime.opened[2]!.key).toBe(`worker-${a}`)
    expect(w.runtime.opened[2]!.resume).toBe(w.runtime.sessions[0]!.sessionId)
    expect(w.runtime.active).toBe(2)
    expect(w.runtime.maxActive).toBe(2)
    expect(w.runtime.opened.some(spec => spec.key === `worker-${c}`)).toBe(false)
    g.open(`worker-${b}`)
    await waitUntil(() => w.runtime.opened.some(spec => spec.key === `worker-${c}`))
  } finally { await w.close() }
})
