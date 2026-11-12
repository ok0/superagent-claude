// Ported from dsh-superagent-prototype (MIT) src/executor/dsh.ts
/**
 * Restart recovery: a running Assignment is ended with `Engine.assignmentInterrupted`, then relaunched with the
 * recovery note as its first Input, unless its latest report settled it (`waiting`, `ready`, `blocked`, `failed`)
 * and its worker caught up. A settled one keeps its session and takes no slot or turn until an Input arrives.
 * Launches coalesce per Assignment, so none is queued twice.
 * The previous process's sessions and background work are not stopped here; they ended with that process.
 * `interruptRunning` records the same at a graceful stop (SIGTERM), so the next start only launches what it queued.
 */
import {
  latestAssignment,
  runningAssignment,
  waitsForPerson,
  type EngineForExecutor,
  type Executor,
  type Repositories,
  type Ticket,
} from '../core/index.ts'

export interface RecoveryHost {
  tickets: Pick<Repositories['tickets'], 'open'>
  engine: Pick<EngineForExecutor, 'assignmentInterrupted'>
  executor: Pick<Executor, 'start'>
}
export interface InterruptHost {
  tickets: Pick<Repositories['tickets'], 'open'>
  engine: Pick<EngineForExecutor, 'assignmentInterrupted'>
}

function oldestFirst(tickets: Pick<Repositories['tickets'], 'open'>): Ticket[] {
  return [...tickets.open()].reverse().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
/** Recovers open tickets oldest first. `open()` lists newest first, so ties on createdAt keep creation order. */
export function recover(host: RecoveryHost): string[] {
  const tickets = oldestFirst(host.tickets)
  for (const ticket of tickets) {
    const running = runningAssignment(ticket),
      latest = latestAssignment(ticket)
    if (running) host.engine.assignmentInterrupted(ticket.id, running.id)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) host.executor.start(ticket, latest)
  }
  return tickets.map(ticket => ticket.id)
}
/**
 * At a graceful stop: every running Assignment is handled with `assignmentInterrupted` (oldest ticket first),
 * as recovery would at the next start. Returns the ids of the tickets that had one.
 */
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
