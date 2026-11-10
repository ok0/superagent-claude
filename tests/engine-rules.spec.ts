import { describe, expect, it, vi } from 'vitest'
import { Engine, UserError, latestReport, ticketOutcome, ticketStage, type EngineForExecutor, type EngineForMainSession, type EngineForPeople,
  type EngineForSettings, type EngineForSources, type ReportState, type TicketStage } from '../src/core/index.ts'
import { accepted, harness, trigger } from './fixtures/engine.ts'

describe('core index', () => {
  it('exposes Engine and the role interfaces', () => {
    type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const h = harness()
    expect(h.engine).toBeInstanceOf(Engine)
    const sources: EngineForSources = h.engine
    const main: EngineForMainSession = h.engine
    const people: EngineForPeople = h.engine
    const settings: EngineForSettings = h.engine
    const executor: EngineForExecutor = h.engine
    expect(typeof sources.receive).toBe('function')
    expect(typeof main.decide).toBe('function')
    expect(typeof people.stopTicket).toBe('function')
    expect(typeof settings.policyChanged).toBe('function')
    expect(typeof executor.report).toBe('function')
    const check: { [K in 'sources' | 'main' | 'people' | 'settings' | 'executor']: true } = {
      sources: true satisfies Exact<keyof EngineForSources, 'receive' | 'bindThread' | 'threadClosed'>,
      main: true satisfies Exact<keyof EngineForMainSession, 'candidate' | 'candidateDelivered' | 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note'>,
      people: true satisfies Exact<keyof EngineForPeople, 'stopTicket' | 'retryTicket' | 'reevaluate' | 'unsubscribe' | 'dismiss'>,
      settings: true satisfies Exact<keyof EngineForSettings, 'policyChanged'>,
      executor: true satisfies Exact<keyof EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'assignmentInterrupted' | 'report' | 'markUnrelated' | 'handback' | 'followForContext' | 'reply' | 'bindThread'>,
    }
    expect(Object.values(check).every(Boolean)).toBe(true)
  })
})

describe('idempotent accept', () => {
  it('accepts the same Trigger twice into one Ticket with one Mandate', () => {
    const h = harness()
    expect(h.engine.receive(trigger('1'))).toBe('stored')
    expect(h.engine.receive(trigger('1'))).toBe('duplicate')
    h.pump()
    const first = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })
    h.settle()
    const second = h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'again' })
    expect(second).toEqual(first)
    expect(h.repo.tickets.list()).toHaveLength(1)
    const accepts = h.repo.decisions.byThread('chat:t1').filter(d => d.kind === 'accept')
    expect(accepts).toHaveLength(1)
    expect(accepts.filter(d => d.mandate !== undefined)).toHaveLength(1)
    expect(h.repo.tickets.get(first.ticketId!)!.mandate).toEqual(accepts[0]!.mandate)
    expect(h.repo.tickets.get(first.ticketId!)!.mandate).toMatchObject({ strength: 'explicit' })
  })
})

describe('subscription fan-out and hand-back', () => {
  it("delivers a person's message on a subscribed Ticket Thread to its Executor without an Eval", () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const before = h.requests.length
    vi.mocked(h.executor.deliver).mockClear()
    h.engine.receive(trigger('2'))
    h.pump()
    expect(h.requests).toHaveLength(before)
    expect(h.repo.decisions.byThread('chat:t1')).toHaveLength(1)
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: [] })
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
    expect(h.executor.deliver).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.executor.deliver).mock.calls[0]![0].id).toBe(ticketId)
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]![0]).toBe(ticketId)
    expect(h.repo.triggers.disposition('2')).toMatchObject({ fanout: [ticketId] })
  })

  it('hands a message back once, which starts a new Eval, and a repeated hand-back starts none', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2'))
    h.pump()
    const before = h.requests.length
    expect(h.engine.handback(ticketId, '2', 'A new request')).toBe(true)
    h.pump()
    expect(h.requests).toHaveLength(before + 1)
    expect(h.requests.at(-1)).toMatchObject({ triggers: [{ id: '2' }] })
    h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chat' })
    expect(() => h.engine.handback(ticketId, '2', 'Again')).toThrow(new UserError('handedBack'))
    h.pump()
    expect(h.requests).toHaveLength(before + 1)
  })
})

describe('reports and stage', () => {
  it.each([
    ['progress', { stage: 'working' }, undefined],
    ['waiting', { stage: 'idle' }, undefined],
    ['ready', { stage: 'ended' }, 'completed'],
    ['blocked', { stage: 'person', action: 'blocked' }, undefined],
    ['failed', { stage: 'person', action: 'failed' }, undefined],
    ['dropped', { stage: 'ended' }, 'dropped'],
  ] as const)('reflects a %s report through the Engine', (state, stage, outcome) => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const mandate = structuredClone(h.repo.tickets.get(ticketId)!.mandate)
    h.tick(10)
    h.engine.report(ticketId, { state, summary: `s-${state}` })
    const t = h.repo.tickets.get(ticketId)!
    expect(latestReport(t)).toMatchObject({ state, summary: `s-${state}` })
    expect(ticketStage(t)).toEqual(stage)
    expect(ticketOutcome(t)).toBe(outcome)
    expect(t.mandate).toEqual(mandate)
  })

  it('computes stage from the Ticket record alone and reaches the Executor, Assessor and Outbox only through their ports', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(h.assessor.request).toHaveBeenCalled()
    expect(h.executor.start).toHaveBeenCalledTimes(1)
    expect(h.outbox.some(m => m.kind === 'acknowledgement')).toBe(true)
    expect(Object.keys(h.executor).sort()).toEqual(['deliver', 'start', 'stop'])
    h.tick(10)
    h.engine.report(ticketId, { state: 'blocked', summary: 'stuck' })
    const record = structuredClone(h.repo.tickets.get(ticketId)!)
    vi.mocked(h.executor.start).mockReset()
    vi.mocked(h.executor.deliver).mockReset()
    vi.mocked(h.executor.stop).mockReset()
    expect(ticketStage(record)).toEqual({ stage: 'person', action: 'blocked' })
    expect(ticketStage(record)).toEqual(ticketStage(h.repo.tickets.get(ticketId)!))
  })
})
