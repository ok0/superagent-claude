/** Each ticket's worker session record in the worker table: runtime session id, workspace, and usage summed per Assignment (ADR-6). */
import type { Store } from '../app/store.ts'
/** One worker session record: the Assignment it serves, its runtime session, workspace and usage totals. */
export interface WorkerRecord { ticketId: string; assignmentId: string; runtime: string; sessionId: string | null; repository: string; cwd: string; branch: string
  pushRemote: string | null; turns: number; costUsd: number; promptVersion: string | null; updatedAt: string }
/** Reads and writes the worker table. */
export class WorkerStore {
  private readonly store: Pick<Store, 'db'>; private readonly now: () => number
  constructor(store: Pick<Store, 'db'>, now: () => number = () => Date.now()) { this.store = store; this.now = now }
  /** Returns the worker record of ticketId, if any. */
  get(ticketId: string): WorkerRecord | undefined {
    const row = this.store.db.prepare('SELECT * FROM worker WHERE ticket_id = ?').get(ticketId)
    if (row === undefined) return undefined
    return {
      ticketId: String(row.ticket_id), assignmentId: String(row.assignment_id), runtime: String(row.runtime),
      sessionId: row.session_id === null ? null : String(row.session_id), repository: String(row.repository), cwd: String(row.cwd),
      branch: String(row.branch), pushRemote: row.push_remote === null ? null : String(row.push_remote),
      turns: Number(row.turns), costUsd: Number(row.cost_usd),
      promptVersion: row.prompt_version === null ? null : String(row.prompt_version), updatedAt: String(row.updated_at),
    }
  }
  /** Inserts or replaces the worker record of `record.ticketId` and stamps it with the current time. */
  put(record: Omit<WorkerRecord, 'updatedAt'>): void {
    this.store.db.prepare(`INSERT INTO worker (ticket_id, assignment_id, runtime, session_id, repository, cwd, branch, push_remote, turns, cost_usd, prompt_version, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ticket_id) DO UPDATE SET assignment_id = excluded.assignment_id, runtime = excluded.runtime, session_id = excluded.session_id,
        repository = excluded.repository, cwd = excluded.cwd, branch = excluded.branch, push_remote = excluded.push_remote, turns = excluded.turns,
        cost_usd = excluded.cost_usd, prompt_version = excluded.prompt_version, updated_at = excluded.updated_at`)
      .run(record.ticketId, record.assignmentId, record.runtime, record.sessionId, record.repository, record.cwd, record.branch,
        record.pushRemote, record.turns, record.costUsd, record.promptVersion, new Date(this.now()).toISOString())
  }
  /** Deletes the worker record of ticketId. */
  clear(ticketId: string): void { this.store.db.prepare('DELETE FROM worker WHERE ticket_id = ?').run(ticketId) }
  /** Records the runtime session id of ticketId's worker record. */
  setSession(ticketId: string, sessionId: string): void {
    this.store.db.prepare('UPDATE worker SET session_id = ?, updated_at = ? WHERE ticket_id = ?').run(sessionId, new Date(this.now()).toISOString(), ticketId)
  }
  /** Records the prompt version the ticket's worker record was opened with. */
  setPromptVersion(ticketId: string, promptVersion: string): void {
    this.store.db.prepare('UPDATE worker SET prompt_version = ?, updated_at = ? WHERE ticket_id = ?').run(promptVersion, new Date(this.now()).toISOString(), ticketId)
  }
  /** Adds one turn's usage to the record's Assignment; a record of another Assignment starts over from zero under assignmentId. Returns the totals (the given values when there is no record). */
  addUsage(ticketId: string, assignmentId: string, turns: number, costUsd: number): { turns: number; costUsd: number } {
    this.store.db.prepare(`UPDATE worker SET turns = CASE WHEN assignment_id = ? THEN turns + ? ELSE ? END,
      cost_usd = CASE WHEN assignment_id = ? THEN cost_usd + ? ELSE ? END, assignment_id = ?, updated_at = ? WHERE ticket_id = ?`)
      .run(assignmentId, turns, turns, assignmentId, costUsd, costUsd, assignmentId, new Date(this.now()).toISOString(), ticketId)
    const record = this.get(ticketId)
    return record ? { turns: record.turns, costUsd: record.costUsd } : { turns, costUsd }
  }
}
