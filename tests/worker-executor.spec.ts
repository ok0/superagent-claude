/**
 * The WorkerExecutor over the Fake runtime: launch and delivery, steering, limits, retries, background work and stops.
 */
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { inputMode } from '../src/executor/worker-executor.ts'
import { accepted, guest, trigger } from './fixtures/engine.ts'
import { gates, workerHarness } from './fixtures/executor.ts'
import { waitUntil } from './fixtures/async.ts'

const AT = '2026-09-23T00:00:00Z'
const lastPersonInput = (w: ReturnType<typeof workerHarness>, id: string): string => w.ticket(id).inputs.filter(input => input.kind === 'trigger').at(-1)!.id

it('only queues a launch from start and opens the session after commit', async () => {
  const w = workerHarness()
  try {
    const t = accepted(w, '1')
    const id = t.ticketId!
    expect(w.runtime.opened).toHaveLength(0)
    expect(w.effects.pending('launch')).toBe(true)
    await waitUntil(() => w.runtime.opened.length === 1)
    const assignmentId = w.ticket(id).assignments[0]!.id
    expect(w.runtime.opened[0]).toMatchObject({ key: `worker-${id}`, role: 'worker', cwd: join(w.directory, 'work', id), limits: { maxTurns: 100, maxBudgetUsd: 5 } })
    expect(w.runtime.sessions[0]!.sent[0]!.id).toBe(`assignment:${assignmentId}`)
  } finally { await w.close() }
})

it("steers a person's message into the running turn without a new Eval", async () => {
  const g = gates()
  const w = workerHarness({ script: ({ index }) => index === 0 ? { hold: g.get('a'), tools: [{ name: 'wait', args: {} }] } : {} })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.runtime.opened.length === 1)
    const requests = w.requests.length
    w.engine.receive(trigger('2', { actor: guest })); w.pump()
    await waitUntil(() => w.runtime.sessions[0]!.sent.some(input => input.mode === 'steer'))
    g.open('a')
    await waitUntil(() => {
      const first = w.ticket(id).inputs[0]
      return first?.kind === 'trigger' && !!first.readAt
    })
    const inputId = lastPersonInput(w, id)
    expect(w.runtime.sessions.length).toBe(1)
    expect(w.runtime.sessions[0]!.turns.length).toBe(1)
    expect(w.runtime.sessions[0]!.turns[0]!.inputs).toContain(inputId)
    expect(w.requests.length).toBe(requests)
  } finally { await w.close() }
})

it('passes a repeated inputsRead to the Engine once', async () => {
  const g = gates()
  const w = workerHarness({ script: ({ index }) => index === 0 ? { hold: g.get('a'), tools: [{ name: 'wait', args: {} }], repeatReads: true } : { repeatReads: true } })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.runtime.opened.length === 1)
    const spy = vi.spyOn(w.engine, 'inputsRead')
    w.engine.receive(trigger('2', { actor: guest })); w.pump()
    await waitUntil(() => w.runtime.sessions[0]!.sent.some(input => input.mode === 'steer'))
    g.open('a')
    await waitUntil(() => {
      const first = w.ticket(id).inputs[0]
      return first?.kind === 'trigger' && !!first.readAt
    })
    const inputId = lastPersonInput(w, id)
    expect(spy.mock.calls.filter(call => call[1].includes(inputId)).length).toBe(1)
  } finally { await w.close() }
})

it("resumes an idle ticket from its stored session id and directory for a person's message", async () => {
  const w = workerHarness()
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => !!w.runtime.sessions[0]?.closed)
    const stored = w.workers.get(id)!
    w.engine.receive(trigger('2', { actor: guest })); w.pump()
    await waitUntil(() => w.runtime.opened.length === 2)
    expect(w.runtime.opened[1]!.resume).toBe(stored.sessionId)
    expect(w.runtime.opened[1]!.cwd).toBe(stored.cwd)
    expect(w.runtime.sessions[1]!.sent[0]).toMatchObject({ mode: 'steer' })
  } finally { await w.close() }
})

it('runs no delivery queued in a transaction that rolled back', async () => {
  const w = workerHarness()
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => !!w.runtime.sessions[0]?.closed)
    expect(() => w.store.atomic(() => { w.executor.deliver(w.ticket(id)); throw new Error('rolled back') })).toThrow('rolled back')
    await w.effects.idle()
    expect(w.effects.pending('delivery')).toBe(false)
    expect(w.runtime.opened.length).toBe(1)
  } finally { await w.close() }
})

it('maps each ticket input to its mode', () => {
  expect(inputMode({ id: 'i', kind: 'trigger', triggerId: 't', at: AT, human: true })).toBe('steer')
  expect(inputMode({ id: 'i', kind: 'trigger', triggerId: 't', at: AT })).toBe('followup')
  expect(inputMode({ id: 'i', kind: 'text', text: 'x', at: AT })).toBe('followup')
  expect(inputMode({ id: 'i', kind: 'note', text: 'x', at: AT })).toBe('inject')
  expect(inputMode({ id: 'i', kind: 'policy-changed', from: 'a', to: 'b', at: AT })).toBe('followup')
  expect(inputMode({ id: 'i', kind: 'resumed', triggerId: 't', at: AT })).toBe('followup')
  expect(inputMode({ id: 'i', kind: 'reopen', decisionId: 'd', at: AT })).toBe('inject')
})

it('blocks a ticket whose turns exceed the limit across a resumed session of the same Assignment', async () => {
  const w = workerHarness({ limits: { maxTurns: 3, maxBudgetUsd: 5 }, script: () => ({ turnEnded: { turns: 2 } }) })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => !!w.runtime.sessions[0]?.closed)
    w.engine.receive(trigger('2', { actor: guest })); w.pump()
    await waitUntil(() => w.ticket(id).assignments[0]!.report?.state === 'blocked')
    expect(w.ticket(id).assignments[0]!.report).toMatchObject({ state: 'blocked', summary: 'turn limit' })
    expect(w.runtime.opened[1]!.resume).toBe(w.runtime.sessions[0]!.sessionId)
    expect(w.runtime.sessions[1]!.interrupts).toBe(1)
    expect(w.runtime.sessions[1]!.closed).toBe(true)
    expect(w.slots.used).toBe(0)
    expect(w.workers.get(id)!.turns).toBe(4)
  } finally { await w.close() }
})

it('blocks a ticket whose cost exceeds the budget', async () => {
  const w = workerHarness({ script: () => ({ turnEnded: { costUsd: 3 } }) })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => !!w.runtime.sessions[0]?.closed)
    w.engine.receive(trigger('2', { actor: guest })); w.pump()
    await waitUntil(() => w.ticket(id).assignments[0]!.report?.state === 'blocked')
    expect(w.ticket(id).assignments[0]!.report).toMatchObject({ state: 'blocked', summary: 'budget limit' })
    expect(w.runtime.opened[1]!.resume).toBe(w.runtime.sessions[0]!.sessionId)
    expect(w.runtime.sessions[1]!.interrupts).toBe(1)
    expect(w.runtime.sessions[1]!.closed).toBe(true)
    expect(w.slots.used).toBe(0)
    expect(w.workers.get(id)!.costUsd).toBe(6)
  } finally { await w.close() }
})

it('blocks on a limit outcome the runtime reports', async () => {
  const w = workerHarness({ script: () => ({ turnEnded: { outcome: 'max_turns' } }) })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.ticket(id).assignments[0]!.report?.state === 'blocked')
    expect(w.ticket(id).assignments[0]!.report).toMatchObject({ state: 'blocked', summary: 'turn limit' })
    expect(w.slots.used).toBe(0)
  } finally { await w.close() }
})

it('counts usage from zero for a new Assignment', async () => {
  const w = workerHarness({ limits: { maxTurns: 3, maxBudgetUsd: 5 }, script: () => ({ turnEnded: { turns: 2 } }) })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => !!w.runtime.sessions[0]?.closed)
    w.engine.receive(trigger('2', { actor: guest })); w.pump()
    await waitUntil(() => w.ticket(id).assignments[0]!.report?.state === 'blocked')
    w.engine.retryTicket(id)
    await waitUntil(() => w.ticket(id).assignments[1]?.idleAt !== undefined)
    expect(w.workers.get(id)).toMatchObject({ assignmentId: w.ticket(id).assignments[1]!.id, turns: 2 })
    expect(w.ticket(id).assignments[1]!.report).toBeUndefined()
  } finally { await w.close() }
})

it('retries a passing runtime error and goes on', async () => {
  let n = 0
  const w = workerHarness({ script: () => n++ < 2 ? { error: { message: 'connection reset', retryable: true } } : {} })
  try {
    const id = accepted(w, '1').ticketId!
    const a = w.ticket(id).assignments[0]!.id
    await waitUntil(() => w.clock.pending > 0)
    w.clock.advance(15_000)
    await waitUntil(() => w.clock.pending > 0)
    w.clock.advance(30_000)
    await waitUntil(() => !!w.runtime.sessions[0]?.closed)
    const sent = w.runtime.sessions[0]!.sent.map(input => input.id)
    expect(sent).toContain(`retry:${a}:1`)
    expect(sent).toContain(`retry:${a}:2`)
    expect(w.ticket(id).assignments[0]!.report).toBeUndefined()
    expect(w.ticket(id).assignments[0]!.idleAt).toBeDefined()
    expect(w.slots.used).toBe(0)
  } finally { await w.close() }
})

it('reports failed once the retries run out', async () => {
  const w = workerHarness({ script: () => ({ error: { message: 'connection reset', retryable: true } }) })
  try {
    const id = accepted(w, '1').ticketId!
    for (const ms of [15_000, 30_000, 60_000]) {
      await waitUntil(() => w.clock.pending > 0)
      w.clock.advance(ms)
    }
    await waitUntil(() => w.ticket(id).assignments[0]!.report?.state === 'failed')
    expect(w.ticket(id).assignments[0]!.report).toMatchObject({ state: 'failed', summary: 'connection reset' })
    expect(w.slots.used).toBe(0)
  } finally { await w.close() }
})

it('reports failed for an error that cannot be retried', async () => {
  const w = workerHarness({ script: () => ({ error: { message: 'bad request', retryable: false } }) })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.ticket(id).assignments[0]!.report?.state === 'failed')
    expect(w.ticket(id).assignments[0]!.report).toMatchObject({ state: 'failed', summary: 'bad request' })
    expect(w.runtime.sessions[0]!.closed).toBe(true)
    expect(w.slots.used).toBe(0)
  } finally { await w.close() }
})

it('reports failed when the workspace cannot be prepared', async () => {
  const w = workerHarness({ prepare: async () => { throw new Error('disk full') } })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.ticket(id).assignments[0]!.report?.state === 'failed')
    expect(w.ticket(id).assignments[0]!.report).toMatchObject({ state: 'failed', summary: 'The workspace could not be prepared: disk full' })
    expect(w.runtime.opened.length).toBe(0)
    expect(w.slots.used).toBe(0)
  } finally { await w.close() }
})

it('keeps the slot while background work runs and stops it 30 minutes after the last activity', async () => {
  const w = workerHarness({ script: ({ index }) => index === 0 ? { turnEnded: { background: 1 } } : {} })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.ticket(id).assignments[0]!.idleAt !== undefined && w.clock.pending > 0)
    expect(w.slots.holds(id)).toBe(true)
    expect(w.runtime.sessions[0]!.closed).toBe(false)
    w.clock.advance(30 * 60_000 - 1)
    expect(w.slots.holds(id)).toBe(true)
    w.clock.advance(1)
    await waitUntil(() => !!w.runtime.sessions[0]?.closed)
    expect(w.slots.used).toBe(0)
    expect(w.runtime.sessions[0]!.interrupts).toBe(1)
  } finally { await w.close() }
})

it('releases the slot when a turn ends with nothing left to do', async () => {
  const w = workerHarness()
  try {
    accepted(w, '1')
    await waitUntil(() => !!w.runtime.sessions[0]?.closed)
    expect(w.slots.used).toBe(0)
    expect(w.runtime.sessions[0]!.interrupts).toBe(0)
  } finally { await w.close() }
})

it('stops a running session when a person stops the ticket and frees its slot', async () => {
  const w = workerHarness({ script: ({ index }) => index === 0 ? { hold: new Promise(() => {}) } : {} })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.runtime.opened.length === 1 && w.ticket(id).assignments[0]!.state === 'running')
    w.engine.stopTicket(id)
    await waitUntil(() => !!w.runtime.sessions[0]?.closed)
    expect(w.runtime.sessions[0]!.interrupts).toBe(1)
    expect(w.slots.used).toBe(0)
  } finally { await w.close() }
})
