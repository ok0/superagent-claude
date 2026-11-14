/**
 * An execution environment block: the operator sees the detail in the log and needs, the person gets one neutral note per block, and the work so far stays.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CONFIG_KEY_PATHS } from '../src/app/config.ts'
import { eventRecord } from '../src/app/runtime.ts'
import { formatNeeds, needsView } from '../src/app/status.ts'
import { openReadOnly } from '../src/app/store-read.ts'
import { environmentBlockedText } from '../src/core/replies.ts'
import { ticketStage } from '../src/core/stage.ts'
import { recover } from '../src/executor/recovery.ts'
import { accepted, guest, trigger } from './fixtures/engine.ts'
import { workerHarness } from './fixtures/executor.ts'
import { waitUntil } from './fixtures/async.ts'

const DETAIL = 'protoc missing; proxy.golang.org unreachable'
const PULL = 'https://example.test/pull/7'
const hold = () => ({ hold: new Promise(() => {}) })
const notes = (w: ReturnType<typeof workerHarness>, id: string) =>
  w.outbox.filter(m => m.id.startsWith('environment-blocked:') && m.ticketId === id)

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'environment-blocked-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

it('tells the person once with the work so far and tells the operator the detail', async () => {
  const w = workerHarness({ directory, script: hold })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.runtime.opened.length === 1)
    w.engine.bindThread(id, { source: 'gh', id: 'pr-7' }, true, PULL)
    w.engine.report(id, { state: 'blocked', summary: 'Proto synced; codegen not run', environment: DETAIL })
    const assignment = w.ticket(id).assignments[0]!
    const messages = notes(w, id)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: `environment-blocked:${assignment.id}:1`,
      kind: 'reply',
      channel: w.store.triggers.get('1')!.channel,
      text: environmentBlockedText(PULL),
    })
    const text = messages[0]!.text
    expect(text).toContain(`Work so far: ${PULL}.`)
    expect(text).not.toContain(DETAIL)
    expect(text).not.toContain('protoc')
    expect(text).not.toContain('?')
    expect(text).not.toContain('issuecrew.json')
    for (const path of CONFIG_KEY_PATHS) expect(text).not.toContain(path)
    expect(/\bM[0-9]+\b/.test(text)).toBe(false)
    expect(/milestone/i.test(text)).toBe(false)
    expect(assignment.environment).toBe(DETAIL)
    expect(assignment.report).toMatchObject({
      state: 'blocked',
      summary: `Proto synced; codegen not run. Work so far: ${PULL}`,
    })
    const events = w.events.filter(e => e.type === 'worker.environment_blocked')
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toEqual({ ticketId: id, assignmentId: assignment.id, detail: DETAIL })
    expect(ticketStage(w.ticket(id))).toEqual({ stage: 'person', action: 'blocked' })
    expect(w.ticket(id).ended).toBeUndefined()
    expect(w.ticket(id).follows?.some(f => f.own)).toBe(true)
    expect(w.ticket(id).attention).toBeUndefined()
  } finally {
    await w.close()
  }
})

it('without a pull request the note leaves the work link out', async () => {
  const w = workerHarness({ directory, script: hold })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.runtime.opened.length === 1)
    w.engine.report(id, { state: 'blocked', summary: 'Proto synced', environment: DETAIL })
    const messages = notes(w, id)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toBe(environmentBlockedText())
    expect(messages[0]!.text).not.toContain('Work so far')
  } finally {
    await w.close()
  }
})

it('a replay and a restart post nothing more, and a new block after a person reply posts one more', async () => {
  const w = workerHarness({ directory, script: hold })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.runtime.opened.length === 1)
    w.engine.report(id, { state: 'blocked', summary: 'x', environment: DETAIL })
    w.engine.report(id, { state: 'blocked', summary: 'x', environment: DETAIL })
    expect(notes(w, id)).toHaveLength(1)
    w.tick(1)
    w.engine.receive(trigger('2', { actor: guest }))
    w.pump()
    await waitUntil(() => w.ticket(id).inputs.some(i => i.kind === 'trigger' && i.triggerId === '2'))
    w.engine.report(id, { state: 'blocked', summary: 'x', environment: DETAIL })
    expect(notes(w, id)).toHaveLength(2)
    expect(notes(w, id)[1]!.id).toBe(`environment-blocked:${w.ticket(id).assignments[0]!.id}:2`)
  } finally {
    await w.close()
  }
  const w2 = workerHarness({ directory, start: false, script: hold })
  try {
    const id = w2.store.tickets.list()[0]!.id
    recover({ tickets: w2.store.tickets, engine: w2.engine, executor: w2.executor })
    w2.effects.start()
    await w2.effects.idle()
    expect(w2.outbox.filter(m => m.id.startsWith('environment-blocked:'))).toHaveLength(0)
  } finally {
    await w2.close()
  }
})

it('a later report without the detail clears it and posts no note', async () => {
  const w = workerHarness({ directory, script: hold })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.runtime.opened.length === 1)
    w.engine.report(id, { state: 'blocked', summary: 'x', environment: DETAIL })
    w.engine.report(id, { state: 'blocked', summary: 'x' })
    expect(w.ticket(id).assignments[0]!.environment).toBeUndefined()
    expect(notes(w, id)).toHaveLength(1)
  } finally {
    await w.close()
  }
})

it('needs shows Environment blocked with the detail', async () => {
  const w = workerHarness({ directory, script: hold })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.runtime.opened.length === 1)
    w.engine.report(id, { state: 'blocked', summary: 'x', environment: DETAIL })
    const reader = openReadOnly(join(directory, 'db.sqlite'))
    const view = needsView(reader, { all: false, endedWithinMs: 0, now: Date.now() })
    expect(view.person.find(i => i.ticketId === id)).toMatchObject({ label: 'Environment blocked', text: DETAIL })
    expect(formatNeeds(view, false)).toContain(`Environment blocked: ${DETAIL}`)
  } finally {
    await w.close()
  }
})

it('the log record of an environment block is a warning with the detail', () => {
  expect(
    eventRecord({
      type: 'worker.environment_blocked',
      at: 'T',
      data: { ticketId: 't', assignmentId: 'a', detail: DETAIL },
    } as never),
  ).toEqual({
    level: 'warn',
    at: 'T',
    event: 'worker.environment_blocked',
    ticketId: 't',
    assignmentId: 'a',
    detail: DETAIL,
  })
  const limit = eventRecord({
    type: 'worker.limit',
    at: 'T',
    data: { ticketId: 't', assignmentId: 'a', limit: 'turn', kept: false },
  } as never)
  expect(limit.level).toBe('info')
  expect(limit).not.toHaveProperty('detail')
})

it('an environment detail on a non-blocked report is ignored', async () => {
  const w = workerHarness({ directory, script: hold })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.runtime.opened.length === 1)
    w.engine.report(id, { state: 'progress', summary: 's', environment: DETAIL })
    expect(notes(w, id)).toHaveLength(0)
    expect(w.events.filter(e => e.type === 'worker.environment_blocked')).toHaveLength(0)
    expect(w.ticket(id).assignments[0]!.environment).toBeUndefined()
  } finally {
    await w.close()
  }
})
