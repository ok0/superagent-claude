/**
 * Restart recovery: a running Assignment is restarted with the recovery note first unless its worker is settled and caught up, tickets recover oldest first under the slot rule, and recovery queues one launch per ticket; idle settled tickets keep their stored session and take no slot until an Input arrives.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { key } from '../src/core/index.ts'
import { ticketStage } from '../src/core/stage.ts'
import { recover } from '../src/executor/recovery.ts'
import { accepted, guest, trigger } from './fixtures/engine.ts'
import { gates, workerHarness } from './fixtures/executor.ts'
import { waitUntil } from './fixtures/async.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'recovery-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it('ends a running Assignment on restart and resumes its session with the recovery note first', async () => {
  const w1 = workerHarness({ directory, script: () => ({ hold: new Promise(() => {}) }) })
  const id = accepted(w1, '1').ticketId!
  await waitUntil(() => !!w1.workers.get(id)?.sessionId && w1.ticket(id).assignments[0]!.state === 'running')
  const stored = w1.workers.get(id)!
  await w1.effects.drain()
  w1.store.close()

  const w2 = workerHarness({ directory, start: false })
  recover({ tickets: w2.store.tickets, engine: w2.engine, executor: w2.executor })
  w2.effects.start()
  await waitUntil(() => (w2.runtime.sessions[0]?.sent.length ?? 0) >= 2)
  const t = w2.ticket(id)
  expect(t.assignments[0]).toMatchObject({ state: 'ended', endedReason: 'hostRestarted' })
  expect(t.assignments[1]!.state).toBe('running')
  expect(w2.runtime.opened[0]).toMatchObject({ resume: stored.sessionId, cwd: stored.cwd })
  expect(w2.runtime.sessions[0]!.sent[0]).toMatchObject({ id: key('input', id, 'restart', t.assignments[1]!.id), mode: 'followup' })
  expect(w2.runtime.sessions[0]!.sent[0]!.text).toContain('The host restarted')
  expect(w2.runtime.sessions[0]!.sent[1]!.id).toBe(`assignment:${t.assignments[1]!.id}`)
})

it('recovers running tickets oldest first under the slot rule', async () => {
  const w1 = workerHarness({ directory, max: 2, script: () => ({ hold: new Promise(() => {}) }) })
  const first = accepted(w1, '1', 't1').ticketId!
  w1.tick(1)
  const second = accepted(w1, '2', 't2').ticketId!
  await waitUntil(() => w1.runtime.active === 2)
  await w1.effects.drain()
  w1.store.close()

  const g = gates()
  const w2 = workerHarness({ directory, max: 1, start: false, script: ({ spec, index }) => index === 0 ? { hold: g.get(spec.key) } : {} })
  recover({ tickets: w2.store.tickets, engine: w2.engine, executor: w2.executor })
  w2.effects.start()
  await waitUntil(() => w2.runtime.opened.length === 1)
  expect(w2.runtime.opened[0]!.key).toBe(`worker-${first}`)
  await w2.effects.idle('launch')
  expect(w2.runtime.opened.length).toBe(1)
  g.open(`worker-${first}`)
  await waitUntil(() => w2.runtime.opened.length === 2)
  expect(w2.runtime.opened[1]!.key).toBe(`worker-${second}`)
  expect(w2.runtime.maxActive).toBe(1)
})

it('queues one launch per ticket however often recovery runs', async () => {
  const w1 = workerHarness({ directory, script: () => ({ hold: new Promise(() => {}) }) })
  accepted(w1, '1')
  await waitUntil(() => w1.runtime.opened.length === 1)
  await w1.effects.drain()
  w1.store.close()

  const w2 = workerHarness({ directory, start: false })
  recover({ tickets: w2.store.tickets, engine: w2.engine, executor: w2.executor })
  recover({ tickets: w2.store.tickets, engine: w2.engine, executor: w2.executor })
  expect(Number(w2.store.db.prepare("SELECT COUNT(*) AS n FROM effect WHERE kind = 'launch'").get()!.n)).toBe(1)
  w2.effects.start()
  await waitUntil(() => w2.runtime.opened.length === 1)
  await w2.effects.idle()
  expect(w2.runtime.opened.length).toBe(1)
})

it('does not resume an ended ticket on restart', async () => {
  const w1 = workerHarness({ directory, max: 2, script: () => ({ hold: new Promise(() => {}) }) })
  const first = accepted(w1, '1', 't1').ticketId!
  w1.tick(1)
  const second = accepted(w1, '2', 't2').ticketId!
  await waitUntil(() => w1.runtime.active === 2)
  w1.engine.report(second, { state: 'ready', summary: 'done' })
  expect(w1.ticket(second).ended).toBeDefined()
  const ended = w1.ticket(second).assignments
  await w1.effects.drain()
  w1.store.close()

  const w2 = workerHarness({ directory, start: false })
  expect(recover({ tickets: w2.store.tickets, engine: w2.engine, executor: w2.executor })).toEqual([first])
  w2.effects.start()
  await waitUntil(() => w2.runtime.opened.length === 1)
  await w2.effects.idle('launch')
  expect(w2.runtime.opened.map(spec => spec.key)).toEqual([`worker-${first}`])
  expect(w2.ticket(second).assignments).toEqual(ended)
})

it('leaves idle ready tickets without a session on restart and resumes only the one at work', async () => {
  const w1 = workerHarness({ directory, max: 3, script: ({ inputs, index }) => {
    const text = inputs.map(input => input.text).join('')
    if (text.includes('"trigger_id":"3"')) return { hold: new Promise(() => {}) }
    if (text.includes('"trigger_id":"5"')) return {}
    if (index === 0) return { tools: [{ name: 'report', args: { state: 'ready', summary: 'PR opened' } }] }
    return {}
  } })
  const a = accepted(w1, '1', 't1').ticketId!
  w1.engine.bindThread(a, { source: 'gh', id: 'pr-1' }, true)
  w1.tick(1)
  const b = accepted(w1, '2', 't2').ticketId!
  w1.engine.bindThread(b, { source: 'gh', id: 'pr-2' }, true)
  w1.tick(1)
  const c = accepted(w1, '3', 't3').ticketId!
  await waitUntil(() => w1.ticket(a).assignments[0]?.report?.state === 'ready' && w1.ticket(b).assignments[0]?.report?.state === 'ready')
  await waitUntil(() => !!w1.runtime.sessions[0]?.closed && !!w1.runtime.sessions[1]?.closed)
  w1.tick(1)
  w1.engine.receive(trigger('5', { actor: guest, threads: [{ source: 'chat', id: 't2' }] })); w1.pump()
  await waitUntil(() => w1.ticket(b).assignments[0]!.idleAt !== undefined && w1.ticket(b).assignments[0]!.deliveredAt !== undefined
    && w1.ticket(b).assignments[0]!.idleAt! >= w1.ticket(b).assignments[0]!.deliveredAt! && w1.runtime.sessions.length === 4 && w1.runtime.sessions[3]!.closed)
  const resumed = w1.workers.get(a)!.sessionId
  await w1.effects.drain()
  w1.store.close()

  const w2 = workerHarness({ directory, max: 3, start: false, script: () => ({ hold: new Promise(() => {}) }) })
  recover({ tickets: w2.store.tickets, engine: w2.engine, executor: w2.executor })
  w2.effects.start()
  await waitUntil(() => w2.runtime.opened.length === 1)
  await w2.effects.idle('launch')
  expect(w2.runtime.opened.map(spec => spec.key)).toEqual([`worker-${c}`])
  expect(w2.events.filter(e => e.type === 'assignment.started').map(e => e.data.ticketId)).toEqual([c])
  for (const id of [a, b]) {
    expect(w2.ticket(id).assignments).toHaveLength(1)
    expect(w2.ticket(id).assignments[0]).toMatchObject({ state: 'running', report: { state: 'ready' } })
  }
  expect(w2.ticket(c).assignments).toHaveLength(2)
  expect(w2.slots.used).toBe(1)
  w2.engine.receive(trigger('6', { actor: guest, threads: [{ source: 'chat', id: 't1' }] })); w2.pump()
  await waitUntil(() => w2.runtime.opened.length === 2)
  expect(w2.runtime.opened[1]!.key).toBe(`worker-${a}`)
  expect(w2.runtime.opened[1]!.resume).toBe(resumed)
})

it('keeps reports when the limits drop below the usage before a restart', async () => {
  const w1 = workerHarness({ directory, limits: { maxTurns: 100, maxBudgetUsd: 5 }, script: ({ index }) => index === 0
    ? { tools: [{ name: 'report', args: { state: 'ready', summary: 'PR opened' } }], turnEnded: { turns: 5, costUsd: 1 } } : {} })
  const id = accepted(w1, '1').ticketId!
  w1.engine.bindThread(id, { source: 'gh', id: 'pr-1' }, true)
  await waitUntil(() => w1.ticket(id).assignments[0]?.report?.state === 'ready')
  await waitUntil(() => !!w1.runtime.sessions[0]?.closed)
  const kept = structuredClone(w1.ticket(id).assignments)
  await w1.effects.drain()
  w1.store.close()

  const w2 = workerHarness({ directory, start: false, limits: { maxTurns: 1, maxBudgetUsd: 0.01 } })
  recover({ tickets: w2.store.tickets, engine: w2.engine, executor: w2.executor })
  w2.effects.start()
  await w2.effects.idle()
  expect(w2.ticket(id).assignments).toEqual(kept)
  expect(w2.events.some(e => e.type === 'worker.limit')).toBe(false)
  expect(w2.runtime.opened).toHaveLength(0)
  expect(ticketStage(w2.ticket(id))).toEqual({ stage: 'person', action: 'review' })
})
