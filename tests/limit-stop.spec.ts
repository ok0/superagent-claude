/**
 * A turn or budget limit that stops a worker: the person gets one note with the limit and the work so far, a ready result stays ready, and a person's reply continues the ticket under a new Assignment with fresh limits.
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

const PULL = 'https://example.test/pull/7'
const INTERNAL = /\b(tickets?|workers?|assignments?)\b/i
const limitMessages = (w: ReturnType<typeof workerHarness>, id: string) =>
  w.outbox.filter(m => m.id.startsWith('limit:') && m.ticketId === id)

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'limit-stop-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

it('tells the person once that a turn limit stopped the work, with the pull request', async () => {
  const w = workerHarness({ script: () => ({ turnEnded: { outcome: 'max_turns' } }) })
  try {
    const id = accepted(w, '1').ticketId!
    w.engine.bindThread(id, { source: 'gh', id: 'pr-7' }, true, PULL)
    await waitUntil(() => w.ticket(id).assignments[0]?.report?.state === 'blocked')
    const assignment = w.ticket(id).assignments[0]!
    expect(assignment.report!.summary).toBe(`turn limit. Work so far: ${PULL}`)
    expect(assignment.limit).toBe('turn')
    const messages = limitMessages(w, id)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: `limit:${assignment.id}`,
      kind: 'reply',
      channel: w.store.triggers.get('1')!.channel,
      text: `I stopped before finishing: the turn limit for this task was reached. Work so far: ${PULL}. Reply here to continue.`,
    })
    expect(INTERNAL.test(messages[0]!.text)).toBe(false)
  } finally {
    await w.close()
  }
})

it('names the budget limit and leaves out the pull request when there is none', async () => {
  const w = workerHarness({ script: () => ({ turnEnded: { outcome: 'budget' } }) })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.ticket(id).assignments[0]?.report?.state === 'blocked')
    expect(w.ticket(id).assignments[0]!.report!.summary).toBe('budget limit')
    const messages = limitMessages(w, id)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toBe(
      'I stopped before finishing: the budget limit for this task was reached. Reply here to continue.',
    )
  } finally {
    await w.close()
  }
})

it('uses the thread address when the binding has none', async () => {
  const g = gates()
  const w = workerHarness({ script: () => ({ hold: g.get('go'), turnEnded: { outcome: 'max_turns' } }) })
  try {
    const id = accepted(w, '1').ticketId!
    w.engine.bindThread(id, { source: 'gh', id: 'pr-7' }, true)
    const t = w.store.threads.get('gh:pr-7')!
    w.store.threads.save({ ...t, meta: { ...t.meta, url: PULL } })
    g.open('go')
    await waitUntil(() => limitMessages(w, id).length === 1)
    expect(limitMessages(w, id)[0]!.text).toContain(`Work so far: ${PULL}.`)
  } finally {
    await w.close()
  }
})

it('does not tell the person twice for one Assignment', async () => {
  const w = workerHarness({ directory, script: () => ({ hold: new Promise(() => {}) }) })
  let id = ''
  try {
    id = accepted(w, '1').ticketId!
    w.engine.bindThread(id, { source: 'gh', id: 'pr-7' }, true, PULL)
    w.engine.report(id, { state: 'blocked', summary: 'turn limit', limit: 'turn' })
    w.engine.report(id, { state: 'blocked', summary: 'turn limit', limit: 'turn' })
    expect(limitMessages(w, id)).toHaveLength(1)
  } finally {
    await w.close()
  }
  const w2 = workerHarness({ directory, start: false })
  try {
    recover({ tickets: w2.store.tickets, engine: w2.engine, executor: w2.executor })
    w2.effects.start()
    await w2.effects.idle()
    expect(w2.outbox.filter(m => m.id.startsWith('limit:'))).toHaveLength(0)
    expect(w2.runtime.opened).toHaveLength(0)
    expect(w2.ticket(id).assignments).toHaveLength(1)
  } finally {
    await w2.close()
  }
})

it('keeps a ready report through a limit with no reply', async () => {
  let n = 0
  const w = workerHarness({
    limits: { maxTurns: 100, maxBudgetUsd: 5 },
    script: () =>
      n++ === 0
        ? { tools: [{ name: 'report', args: { state: 'ready', summary: 'PR opened' } }] }
        : { turnEnded: { costUsd: 6 } },
  })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => !!w.ticket(id).ended)
    w.tick(1)
    w.engine.receive(trigger('2', { actor: guest }))
    w.pump()
    await waitUntil(() => w.events.some(e => e.type === 'worker.limit'))
    await waitUntil(() => w.slots.used === 0)
    expect(limitMessages(w, id)).toHaveLength(0)
    expect(w.ticket(id).assignments[1]!.report).toMatchObject({ state: 'ready', summary: 'PR opened' })
    expect(ticketStage(w.ticket(id))).toEqual({ stage: 'person', action: 'review' })
  } finally {
    await w.close()
  }
})

it('replies where the person last wrote once the worker took their message up', async () => {
  const g = gates()
  let n = 0
  const w = workerHarness({
    limits: { maxTurns: 100, maxBudgetUsd: 5 },
    script: () =>
      n++ === 0
        ? { tools: [{ name: 'report', args: { state: 'ready', summary: 'PR opened' } }] }
        : { hold: g.get('ack'), turnEnded: { costUsd: 6 } },
  })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => !!w.ticket(id).ended)
    w.tick(1)
    const second = trigger('2', { actor: guest, channel: { source: 'chat', thread: 't1', address: { message: '2' } } })
    w.engine.receive(second)
    w.pump()
    await waitUntil(() => w.runtime.sessions.length === 2)
    w.engine.reply({ purpose: 'acknowledgement', ticketId: id, triggerId: '2', text: 'On it' })
    g.open('ack')
    await waitUntil(() => w.ticket(id).assignments[1]?.report?.state === 'blocked')
    const messages = limitMessages(w, id)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.channel).toEqual(second.channel)
  } finally {
    await w.close()
  }
})

it('continues a limit-stopped ticket under a new Assignment when a person replies', async () => {
  let n = 0
  const w = workerHarness({
    limits: { maxTurns: 3, maxBudgetUsd: 5 },
    script: () => (n++ === 0 ? { turnEnded: { outcome: 'max_turns' } } : {}),
  })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.ticket(id).assignments[0]?.report?.state === 'blocked')
    w.engine.receive(trigger('2', { actor: guest }))
    w.pump()
    await waitUntil(() => w.runtime.opened.length === 2)
    const assignments = w.ticket(id).assignments
    expect(assignments[0]).toMatchObject({ state: 'ended', endedReason: 'limitContinued' })
    expect(assignments[1]!.state).toBe('running')
    expect(w.runtime.opened[1]!.resume).toBe(w.runtime.sessions[0]!.sessionId)
    expect(w.runtime.opened[1]!.limits).toEqual({ maxTurns: 3, maxBudgetUsd: 5 })
    expect(w.runtime.sessions[1]!.sent[0]!.id).toBe(key('input', id, 'restart', assignments[1]!.id))
    await waitUntil(() => w.runtime.sessions[1]!.sent.some(item => item.id === key('input', id, 'trigger', '2')))
  } finally {
    await w.close()
  }
})
