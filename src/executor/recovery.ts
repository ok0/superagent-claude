// Ported from dsh-superagent-prototype (MIT) src/executor/dsh.ts
/**
 * Restart recovery: every Assignment that was running when the host stopped is ended with `Engine.assignmentInterrupted`,
 * whose restart gives the new Assignment the recovery note as its first Input and queues its launch; pending launches are
 * queued again. Tickets are handled oldest first, and launches coalesce per Assignment, so none is queued twice.
 * Changes from the reference: rewritten as a function over the core ports and the Executor port; stopping the previous
 * process's sessions and background work is dropped because they ended with that process; the note text stays in core.
 */
import { latestAssignment, runningAssignment, waitsForPerson, type EngineForExecutor, type Executor, type Repositories } from '../core/index.ts'

export interface RecoveryHost {
  tickets: Pick<Repositories['tickets'], 'open'>
  engine: Pick<EngineForExecutor, 'assignmentInterrupted'>
  executor: Pick<Executor, 'start'>
}
/** Recovers open tickets oldest first (`open()` lists newest first, so ties on createdAt keep creation order) and returns their ids in that order. */
export function recover(host: RecoveryHost): string[] {
  const tickets = [...host.tickets.open()].reverse().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const ticket of tickets) {
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) host.engine.assignmentInterrupted(ticket.id, running.id)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) host.executor.start(ticket, latest)
  }
  return tickets.map(ticket => ticket.id)
}
