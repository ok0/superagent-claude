/**
 * Router-session assessor: per-Eval state, context loading, reads and decisions. Adapted from the reference assessment spec.
 * Excluded (D4): the image, file and directory reads of the reference (the repository path reader is not in this build).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ContextMessage, ContextPart, ContextPartName, TriggerContext } from '../src/sources/kind.ts'
import { AssessmentSchema, EvalReadSchema, MasterAssessor, type AssessorHost } from '../src/app/assessment.ts'
import { external } from '../src/app/cards.ts'
import { Engine, MemoryRepositories, type Executor, type Policy, type Trigger } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy/policy.ts'
import { deferred } from './fixtures/async.ts'
import { trigger } from './fixtures/engine.ts'

const message = (id: string, text: string, index = 0): ContextMessage => ({
  id,
  from: 'bob',
  at: new Date(Date.UTC(2026, 8, 9, 0, 0, index)).toISOString(),
  text,
})
/** A thread of `messages`, read five at a time; `gate` holds every read until it resolves. */
function thread(messages: ContextMessage[], messageId: string, gate?: Promise<void>): TriggerContext {
  return {
    messageId,
    read: async (part: ContextPartName, cursor?: string): Promise<ContextPart> => {
      await gate
      if (part !== 'thread') return { messages: [], body: {} }
      const start = Number(cursor ?? 0)
      return {
        messages: messages.slice(start, start + 5),
        next: start + 5 < messages.length ? String(start + 5) : undefined,
        body: {},
      }
    },
  }
}
/** Assessor fixture backed by in-memory repositories and a thread context per trigger. */
function setup(
  strength: 'explicit' | 'inferred' = 'inferred',
  messages = Array.from({ length: 6 }, (_, i) => message(`c${i}`, `comment ${i}`, i)),
  context?: (trigger: Trigger) => TriggerContext | undefined,
) {
  const gate = { hold: undefined as Promise<void> | undefined }
  const repo = new MemoryRepositories()
  const settings = SettingsSchema.parse({})
  let engine!: Engine
  const host: AssessorHost = {
    engine: () => engine,
    settings: () => settings,
    paused: () => false,
    effects: { enqueue: vi.fn(), handle: vi.fn(), cancel: vi.fn() },
    threadContext: context ?? (t => (t.source === 'chat' ? thread(messages, 'c0', gate.hold) : undefined)),
    deliver: vi.fn(async () => {}),
    candidateCard: c => ({ eval_id: c.evalId }),
  }
  const assessor = new MasterAssessor(host)
  const scope = { scope: () => ({ listened: true as const, observed: true }) }
  const policy: Policy = {
    version: 'v1',
    paused: false,
    evalTimeoutMs: 600_000,
    gate: () => ({ admissible: true, strength, basis: { via: 'followup' } }),
    revalidate: () => true,
    admitsInferred: rules => rules.length > 0,
  }
  const executor: Executor = { start: async () => {}, deliver: async () => {}, stop: async () => {} }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  engine = new Engine({ repo, policy: () => policy, scope, assessor, executor, outbox })
  const kept = assessor as unknown as { evals: Map<string, unknown> }
  return { repo, engine, assessor, gate, size: () => kept.evals.size }
}
const signal = new AbortController().signal
const read = (args: Record<string, unknown>) => EvalReadSchema.parse(args)

it('keeps nothing for an Eval once it is decided, as for one that timed out', async () => {
  const s = setup()
  for (let n = 1; n <= 3; n++) {
    s.engine.receive(trigger(String(n), { threads: [{ source: 'chat', id: `t${n}` }] }))
    s.engine.evaluateDue()
    await s.assessor.context(String(n), signal)
    await s.assessor.read(read({ trigger_id: String(n), resource: 'message' }), signal)
    expect(s.size()).toBeGreaterThan(0)
    s.engine.decide(String(n), { kind: 'ignore', reason: 'not a request' })
    expect(s.size()).toBe(0)
  }
  s.engine.receive(trigger('9', { threads: [{ source: 'chat', id: 't9' }] }))
  s.engine.evaluateDue()
  await s.assessor.context('9', signal)
  const thread9 = s.repo.threads.get('chat:t9')!
  s.repo.threads.save({
    ...thread9,
    expired: 2,
    evaluating: { ...thread9.evaluating!, delivered: '2000-01-01T00:00:00.000Z', deadline: '2000-01-01T00:00:00.000Z' },
  })
  s.engine.evaluateDue()
  expect(s.size()).toBe(0)
})

it('keeps nothing from a context read that finishes after its Eval was decided', async () => {
  const s = setup()
  const hold = deferred()
  s.gate.hold = hold.promise
  s.engine.receive(trigger('1', { threads: [{ source: 'chat', id: 't1' }] }))
  s.engine.evaluateDue()
  const details = s.assessor.context('1', signal)
  s.engine.decide('1', { kind: 'ignore', reason: 'not a request' })
  hold.resolve()
  await expect(details).rejects.toThrow('This assessment has finished')
  expect(s.size()).toBe(0)
})

it('reads the context of a Trigger through its Source, and none for a Source that gives none', async () => {
  const s = setup()
  s.engine.receive(trigger('1', { threads: [{ source: 'chat', id: 't1' }] }))
  s.engine.evaluateDue()
  const context = await s.assessor.context('1', signal)
  expect(context.thread).toMatchObject({ complete: true, loaded_messages: 6, source_found: true })
  const page = (await s.assessor.read(read({ trigger_id: '1', resource: 'thread' }), signal)) as { text: string }
  expect(JSON.parse(page.text)).toMatchObject({
    next_read: { trigger_id: '1', resource: 'thread', cursor: '5' },
    messages: expect.arrayContaining([expect.objectContaining({ text: external('thread', 'comment 0') })]),
  })
  s.engine.receive(
    trigger('2', { source: 'probe', threads: [{ source: 'probe', id: '2' }], actor: { source: 'probe', id: 'bob' } }),
  )
  s.engine.evaluateDue()
  expect((await s.assessor.context('2', signal)).thread).toMatchObject({
    error: expect.stringContaining('gives no Thread context'),
  })
  await expect(s.assessor.read(read({ trigger_id: '2', resource: 'thread' }), signal)).rejects.toThrow(
    'gives no Thread context',
  )
  // The Trigger's own text is still readable when its Source provides no Thread context.
  expect(await s.assessor.read(read({ trigger_id: '2', resource: 'message' }), signal)).toMatchObject({
    text: external('thread', 'message 2'),
  })
})

it('routes an explicit candidate instead of assessing it: each eval tool names the routing tools', async () => {
  const s = setup('explicit')
  s.engine.receive(trigger('1', { threads: [{ source: 'chat', id: 't1' }] }))
  s.engine.evaluateDue()
  const routed = 'orchestrator_route with its trigger_id and kind accept, attach, stop or ignore'
  await expect(s.assessor.context('1', signal)).rejects.toThrow(routed)
  await expect(s.assessor.read(read({ trigger_id: '1', resource: 'message' }), signal)).rejects.toThrow(routed)
  const direction = {
    implementation_requested: false,
    target_basis: 'undetermined',
    requires_design_decision: false,
    evidence: 'chatter',
  }
  const decision = { decision: 'ignore', rule_assessments: [], direction, title: 't', scope: 's', reason: 'r' }
  await expect(s.assessor.decide('1', AssessmentSchema.parse(decision), signal)).rejects.toThrow(routed)
})

it('asks the assessment only for decisions its tool accepts, which no longer include reopen or stop', () => {
  const admission = readFileSync('prompts/admission.md', 'utf8')
  expect(admission).not.toMatch(/decision=stop|reopen/)
  const direction = {
    implementation_requested: true,
    target_basis: 'specified',
    requires_design_decision: false,
    evidence: 'e',
  }
  const result = (decision: string, extra = {}) =>
    AssessmentSchema.safeParse({
      decision,
      rule_assessments: [],
      direction,
      title: 't',
      scope: 's',
      reason: 'r',
      ...extra,
    }).success
  expect([result('ignore'), result('unavailable'), result('reopen'), result('stop')]).toEqual([
    true,
    true,
    false,
    false,
  ])
  expect(result('ignore', { ticket_id: 't' })).toBe(false)
})

it('loads a window of the thread: the trigger once, cut messages with their length, and stubs for the rest', async () => {
  const bodies = Array.from(
    { length: 30 },
    (_, i) => `comment ${i}: ${'the label reads oddly on the settings page. '.repeat(i % 4 === 0 ? 40 : 3)}`,
  )
  const messages = bodies.map((body, i) => message(`m${i}`, body, i))
  const s = setup('inferred', messages, t => (t.source === 'chat' ? thread(messages, 'm15') : undefined))
  s.engine.receive(trigger('15', { text: bodies[15]!, threads: [{ source: 'chat', id: 't1' }] }))
  s.engine.evaluateDue()
  const result = (await s.assessor.context('15', signal)) as Record<string, unknown> & {
    thread: { messages: Record<string, unknown>[] }
  }
  expect(result).not.toHaveProperty('instructions')
  expect(result.text).toBe(external('trigger', bodies[15]!))
  const at = (i: number) => result.thread.messages.find(item => item.id === `m${i}`)!
  // The trigger's own text is given once at top level; its two nearest neighbours keep more text than the rest of the window.
  expect(at(15)).toEqual({ id: 'm15', from: 'bob', at: expect.any(String), trigger: true })
  expect(at(16)).toMatchObject({
    chars: bodies[16]!.length,
    text: external('thread', `${bodies[16]!.slice(0, 1200)}…`),
  })
  expect(at(12)).toMatchObject({ chars: bodies[12]!.length, text: external('thread', `${bodies[12]!.slice(0, 400)}…`) })
  expect(at(14)).toMatchObject({ text: external('thread', bodies[14]!) })
  expect(at(14)).not.toHaveProperty('chars')
  // Messages outside the window are stubs that orchestrator_eval_read can read in full.
  expect(at(8)).toEqual({ id: 'm8', from: 'bob', preview: external('thread', bodies[8]!.slice(0, 50)) })
  const whole = await s.assessor.read(read({ trigger_id: '15', resource: 'message', message_id: 'm8' }), signal)
  expect(JSON.stringify(whole)).toContain(bodies[8]!.slice(-40))
  expect(JSON.stringify(result).length).toBeLessThan(9000)
})

it('lets the Router session read on from the cursor its loaded window ends with, and points a cut batch message at its whole text', async () => {
  // Every page returns a next cursor so the bounded window ends with a continuation cursor.
  const endless: TriggerContext = {
    messageId: 'm0',
    read: async (part: ContextPartName, cursor?: string): Promise<ContextPart> => {
      if (part !== 'thread') return { messages: [], body: {} }
      const n = Number(cursor ?? 0)
      return { messages: [message(`m${n}`, `message ${n}`, n)], next: String(n + 1), body: {} }
    },
  }
  const s = setup('inferred', undefined, () => endless)
  s.engine.receive(trigger('1', { threads: [{ source: 'chat', id: 't1' }] }))
  const long = trigger('long', { text: 'a long follow-up. '.repeat(40), threads: [{ source: 'chat', id: 't1' }] })
  s.engine.receive(long)
  s.engine.evaluateDue()
  const result = (await s.assessor.context('long', signal)) as {
    thread: { next_cursor?: string }
    batch: Record<string, unknown>[]
  }
  expect(result.thread.next_cursor).toBe('5')
  const more = await s.assessor.read(read({ trigger_id: 'long', resource: 'thread', cursor: '5' }), signal)
  expect(JSON.stringify(more)).toContain('message 5')
  expect(result.batch).toEqual([expect.objectContaining({ trigger_id: '1' })])

  const s2 = setup('inferred', undefined, () => endless)
  s2.engine.receive(long)
  s2.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't1' }] }))
  s2.engine.evaluateDue()
  const other = (await s2.assessor.context('3', signal)) as { batch: Record<string, unknown>[] }
  expect(other.batch).toEqual([
    expect.objectContaining({ trigger_id: 'long', chars: long.text.length, read: 'trigger/long' }),
  ])
})
