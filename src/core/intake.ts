// Ported from dsh-superagent-prototype (MIT) src/core/intake.ts
import { key } from './ids.ts'
import { isoTime, liveTicket, threadKey } from './model.ts'
import type { Ticket, Trigger } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

/**
 * Queues on its primary thread every trigger that no ticket's worker decides (see `followupOwners`).
 */
export class Intake extends EnginePart {
  private readonly tickets: Tickets
  constructor(options: EngineOptions, tickets: Tickets) {
    super(options)
    this.tickets = tickets
  }

  receive(received: Trigger): ReceiveResult {
    const trigger = { ...received, at: isoTime(received.at) }
    if (!trigger.threads.length) throw new Error('A trigger must belong to at least one thread')
    if (this.repo.triggers.get(trigger.id)) return 'duplicate'
    const at = this.now()
    const filter = this.options.scope.scope(trigger)
    if (!filter.listened) {
      this.repo.triggers.save(trigger)
      this.repo.triggers.saveDisposition(trigger.id, { filtered: { code: filter.reason }, fanout: [], at })
      return 'filtered'
    }
    this.repo.triggers.save(trigger)
    const keys = trigger.threads.map(threadKey)
    // Track reached tickets and whether they were reached only via context threads.
    // A ticket's own thread makes `context` false.
    const reached = new Map<string, { ticket: Ticket; context: boolean }>()
    for (const ref of trigger.threads) {
      const thread = this.thread(ref)
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(other => other !== thread.key)])]
      for (const ticketId of thread.subscriptions) {
        const ticket = this.repo.tickets.get(ticketId)
        // Only a person's message on a non-context thread resumes an ended ticket; bots and CI do not, since the
        // Executor re-reads threads when it resumes. A human-stopped ticket receives nothing: its Mandate is withdrawn.
        const followed = !!thread.context?.includes(ticketId)
        const resumes = trigger.human && ticket?.ended?.by !== 'human' && !followed
        if (!ticket || (!liveTicket(ticket) && !resumes)) continue
        reached.set(ticketId, { ticket, context: followed && (reached.get(ticketId)?.context ?? true) })
      }
      this.repo.threads.save(thread)
    }
    for (const [ticketId, { ticket, context: followed }] of reached) {
      this.tickets.addInput(ticket, {
        id: key('input', ticketId, 'trigger', trigger.id),
        kind: 'trigger',
        triggerId: trigger.id,
        at,
        ...(trigger.human ? { human: true } : {}),
        ...(followed ? { context: true } : {}),
      })
    }
    const fanout = [...reached.keys()],
      context = fanout.filter(id => reached.get(id)!.context)
    const disposition = { fanout, ...(context.length ? { context } : {}), at }
    this.repo.triggers.saveDisposition(trigger.id, disposition)
    // A message no ticket decides, such as one that reached only tickets a person stopped or that follow the Thread
    // for context, and every bot's, goes to Eval.
    if (!this.owners(trigger).length) this.queueForEval(trigger)
    for (const ticketId of fanout) this.tickets.wake(ticketId)
    this.emit('trigger.received', { triggerId: trigger.id, threads: trigger.threads.map(threadKey) })
    return 'stored'
  }
}
