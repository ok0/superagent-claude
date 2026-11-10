import { describe, expect, it, vi } from 'vitest'
import { harness, accepted, trigger, guest } from './fixtures/engine.ts'
import { key, latestReport, runningAssignment } from '../src/core/index.ts'
import type { DomainEvent, Ticket } from '../src/core/index.ts'
import { ticketStage } from '../src/core/stage.ts'
import { inputMode } from '../src/executor/worker-executor.ts'

const ci = { human: false, actor: { source: 'chat', id: '' } }

function resumedAfterReady(h: ReturnType<typeof harness>): string {
  const id = accepted(h).ticketId!
  h.engine.report(id, { state: 'ready', summary: 'PR opened' })
  h.tick(1)
  h.engine.receive(trigger('2', { actor: guest })); h.settle()
  return id
}

describe('a ticket resting on its ready report', () => {
  it('CI that reaches it waits and goes as an inject with the next person\'s message', () => {
    const h = harness()
    const id = resumedAfterReady(h)
    h.engine.handback(id, '2', 'Asks for more')
    h.tick(1)
    const deliver = vi.mocked(h.executor.deliver).mock.calls.length
    const start = vi.mocked(h.executor.start).mock.calls.length
    h.engine.receive(trigger('3', ci)); h.settle()
    const ticket = h.repo.tickets.get(id)!
    const input = ticket.inputs.find(item => item.id === key('input', id, 'trigger', '3'))
    expect(input).toMatchObject({ kind: 'trigger', quiet: true })
    expect(ticket.undelivered).toContain(key('input', id, 'trigger', '3'))
    expect(inputMode(input!)).toBe('inject')
    expect(vi.mocked(h.executor.deliver).mock.calls.length).toBe(deliver)
    expect(vi.mocked(h.executor.start).mock.calls.length).toBe(start)
    expect(h.delivered.some(([, inputId]) => inputId === key('input', id, 'trigger', '3'))).toBe(false)
    h.tick(1); h.engine.receive(trigger('4', { actor: guest })); h.settle()
    const pairs = h.delivered.filter(([, inputId]) => [key('input', id, 'trigger', '3'), key('input', id, 'trigger', '4')].includes(inputId))
    expect(pairs).toEqual([[id, key('input', id, 'trigger', '3')], [id, key('input', id, 'trigger', '4')]])
  })

  it('CI is delivered as before while a person\'s message after the ready report is still open', () => {
    const h = harness()
    const id = resumedAfterReady(h)
    h.tick(1)
    h.engine.receive(trigger('3', ci)); h.settle()
    const input = h.repo.tickets.get(id)!.inputs.find(item => item.id === key('input', id, 'trigger', '3'))
    expect(input).toBeDefined()
    expect(input).not.toHaveProperty('quiet')
    expect(h.delivered).toContainEqual([id, key('input', id, 'trigger', '3')])
  })

  it('a handed-back message is not delivered to its ticket again when the Assignment restarts', () => {
    const h = harness()
    const id = accepted(h).ticketId!
    h.engine.receive(trigger('2', { actor: guest })); h.settle()
    h.engine.handback(id, '2', 'Asks for more')
    h.engine.assignmentInterrupted(id, runningAssignment(h.repo.tickets.get(id)!)!.id)
    h.settle()
    expect(h.delivered.filter(([, input]) => input === key('input', id, 'trigger', '2'))).toHaveLength(1)
  })

  it('a limit stop keeps the ready report when no person\'s message was taken up since', () => {
    const events: DomainEvent[] = []
    const h = harness({}, { emit: event => events.push(event as DomainEvent) })
    const id = resumedAfterReady(h)
    const a = runningAssignment(h.repo.tickets.get(id)!)!.id
    expect(h.engine.limitReached(id, a, 'budget limit')).toBe(true)
    const ticket = h.repo.tickets.get(id)!
    expect(runningAssignment(ticket)!.report).toMatchObject({ state: 'ready', summary: 'PR opened' })
    expect(ticketStage(ticket)).toEqual({ stage: 'person', action: 'review' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'worker.limit', data: { ticketId: id, assignmentId: a, limit: 'budget limit', kept: true } }))
  })

  it('a limit stop after the worker took a person\'s message up keeps nothing', () => {
    const events: DomainEvent[] = []
    const h = harness({}, { emit: event => events.push(event as DomainEvent) })
    const id = resumedAfterReady(h)
    const a = runningAssignment(h.repo.tickets.get(id)!)!.id
    h.engine.reply({ purpose: 'acknowledgement', ticketId: id, triggerId: '2', text: 'On it' })
    expect(h.engine.limitReached(id, a, 'budget limit')).toBe(false)
    expect(runningAssignment(h.repo.tickets.get(id)!)!.report).toBeUndefined()
    expect(events).toContainEqual(expect.objectContaining({ type: 'worker.limit', data: expect.objectContaining({ kept: false }) }))
  })

  it('a limit stop on a ticket without a ready report keeps nothing', () => {
    const h = harness()
    const id = accepted(h).ticketId!
    const a = runningAssignment(h.repo.tickets.get(id)!)!.id
    expect(h.engine.limitReached(id, a, 'turn limit')).toBe(false)
    expect(latestReport(h.repo.tickets.get(id) as Ticket)).toBeUndefined()
  })
})
