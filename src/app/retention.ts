/**
 * Retention of ended tickets: after retention.endedTicketDays a durable cleanup effect removes the ticket's workspace and its worker record (R27).
 */
import type { WorkerStore } from '../executor/worker-store.ts'
import type { WorkspaceProvider } from '../executor/workspaces.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

export const DAY_MS = 86_400_000

export interface RetentionHost {
  store: Pick<Store, 'db' | 'tickets'>
  effects: Pick<Effects, 'handle' | 'enqueue' | 'pending'>
  workspaces: Pick<WorkspaceProvider, 'remove'>
  workers: Pick<WorkerStore, 'clear'>
  /** The current retention.endedTicketDays; read on every evaluation so that a reload applies to the next one. */
  days: () => number
  now?: () => number
  /** Called after a ticket's workspace and worker record are removed. */
  cleaned?: (ticketId: string) => void
}

/** True when the ticket ended at a parseable time at least `days` days before `now`. A ticket with no ended time, or one that does not parse, never expires. */
export function expired(ticket: { ended?: { at: string } }, days: number, now: number): boolean {
  const at = ticket.ended ? Date.parse(ticket.ended.at) : NaN
  return Number.isFinite(at) && now - at >= days * DAY_MS
}

export class Retention {
  private readonly host: RetentionHost
  private readonly now: () => number

  constructor(host: RetentionHost) {
    this.host = host
    this.now = host.now ?? (() => Date.now())
    host.effects.handle('cleanup', payload => this.cleanup(payload.ticketId))
  }

  /** Queues a cleanup for each ended ticket that still has a worker record and has expired, unless one is already waiting. Returns how many were queued. */
  evaluate(): number {
    const rows = this.host.store.db
      .prepare(
        "SELECT w.ticket_id AS id, t.value ->> '$.ended.at' AS ended FROM worker w JOIN ticket t ON t.id = w.ticket_id WHERE t.open IS NULL",
      )
      .all()
    let queued = 0
    for (const row of rows) {
      const id = String(row.id)
      if (typeof row.ended !== 'string') continue
      if (!expired({ ended: { at: row.ended } }, this.host.days(), this.now())) continue
      if (this.host.effects.pending('cleanup', id)) continue
      this.host.effects.enqueue('cleanup', id, { ticketId: id })
      queued++
    }
    return queued
  }

  /** Removes the worker record, then the workspace, of an ended expired ticket. A ticket that is open again, unknown or not expired is left alone. Safe to repeat. */
  async cleanup(ticketId: string): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !expired(ticket, this.host.days(), this.now())) return
    this.host.workers.clear(ticketId)
    await this.host.workspaces.remove(ticketId)
    this.host.cleaned?.(ticketId)
  }
}
