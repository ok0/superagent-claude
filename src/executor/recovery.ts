// Ported from dsh-superagent-prototype (MIT) src/executor/dsh.ts
/**
 * Restart recovery: every Assignment that was running when the host stopped is ended with `Engine.assignmentInterrupted`,
 * whose restart gives the new Assignment the recovery note as its first Input and queues its launch, unless its latest report
 * settled it (`waiting`, `ready`, `blocked`, `failed`) and its worker caught up with what was delivered since. A settled one keeps
 * its stored session and takes no slot or turn until an Input for it arrives (ADR-32). Pending launches are queued again. Tickets are handled oldest first, and launches coalesce per Assignment, so none is queued twice.
 * Changes from the reference: rewritten as a function over the core ports and the Executor port; stopping the previous
 * process's sessions and background work is dropped because they ended with that process; the note text stays in core.
 * `interruptRunning` records the same at a graceful stop (SIGTERM), so the next start only launches what it queued.
 */
import { latestAssignment, runningAssignment, waitsForPerson, type EngineForExecutor, type Executor, type Repositories, type Ticket } from '../core/index.ts'

export interface RecoveryHost {
  tickets: Pick<Repositories['tickets'], 'open'>
  engine: Pick<EngineForExecutor, 'assignmentInterrupted'>
  executor: Pick<Executor, 'start'>
}
export interface InterruptHost { tickets: Pick<Repositories['tickets'], 'open'>; engine: Pick<EngineForExecutor, 'assignmentInterrupted'> }

function oldestFirst(tickets: Pick<Repositories['tickets'], 'open'>): Ticket[] {
  return [...tickets.open()].reverse().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
/** Recovers open tickets oldest first (`open()` lists newest first, so ties on createdAt keep creation order) and returns their ids in that order. */
export function recover(host: RecoveryHost): string[] {
  const tickets = oldestFirst(host.tickets)
  for (const ticket of tickets) {
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) host.engine.assignmentInterrupted(ticket.id, running.id)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) host.executor.start(ticket, latest)
  }
  return tickets.map(ticket => ticket.id)
}
/** At a graceful stop: every running Assignment is handled with `assignmentInterrupted` (oldest ticket first), as recovery would at the next start; returns the ids of the tickets that had one. */
export function interruptRunning(host: InterruptHost): string[] {
  const interrupted: string[] = []
  for (const ticket of oldestFirst(host.tickets)) {
    const running = runningAssignment(ticket)
    if (!running) continue
    host.engine.assignmentInterrupted(ticket.id, running.id)
    interrupted.push(ticket.id)
  }
  return interrupted
}
