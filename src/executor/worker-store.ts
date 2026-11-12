import type { Store } from '../app/store.ts'
export interface WorkerRecord {
  ticketId: string
  assignmentId: string
  runtime: string
  sessionId: string | null
  repository: string
  cwd: string
  branch: string
  turns: number
  costUsd: number
  promptVersion: string | null
  updatedAt: string
}
export class WorkerStore {
  private readonly store: Pick<Store, 'db'>
  private readonly now: () => number
  constructor(store: Pick<Store, 'db'>, now: () => number = () => Date.now()) {
    this.store = store
    this.now = now
  }
  get(ticketId: string): WorkerRecord | undefined {
    const row = this.store.db.prepare('SELECT * FROM worker WHERE ticket_id = ?').get(ticketId)
    if (row === undefined) return undefined
    return {
      ticketId: String(row.ticket_id),
      assignmentId: String(row.assignment_id),
      runtime: String(row.runtime),
      sessionId: row.session_id === null ? null : String(row.session_id),
      repository: String(row.repository),
      cwd: String(row.cwd),
      branch: String(row.branch),
      turns: Number(row.turns),
      costUsd: Number(row.cost_usd),
      promptVersion: row.prompt_version === null ? null : String(row.prompt_version),
      updatedAt: String(row.updated_at),
    }
  }
  put(record: Omit<WorkerRecord, 'updatedAt'>): void {
    // push_remote is always NULL; the column stays for databases written by 0.1.0.
    this.store.db
      .prepare(
        `INSERT INTO worker (ticket_id, assignment_id, runtime, session_id, repository, cwd, branch, push_remote, turns, cost_usd, prompt_version, updated_at)
      VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?)
      ON CONFLICT(ticket_id) DO UPDATE SET assignment_id = excluded.assignment_id, runtime = excluded.runtime, session_id = excluded.session_id,
        repository = excluded.repository, cwd = excluded.cwd, branch = excluded.branch, push_remote = excluded.push_remote, turns = excluded.turns,
        cost_usd = excluded.cost_usd, prompt_version = excluded.prompt_version, updated_at = excluded.updated_at`,
      )
      .run(
        record.ticketId,
        record.assignmentId,
        record.runtime,
        record.sessionId,
        record.repository,
        record.cwd,
        record.branch,
        record.turns,
        record.costUsd,
        record.promptVersion,
        new Date(this.now()).toISOString(),
      )
  }
  clear(ticketId: string): void {
    this.store.db.prepare('DELETE FROM worker WHERE ticket_id = ?').run(ticketId)
  }
  setSession(ticketId: string, sessionId: string): void {
    this.store.db
      .prepare('UPDATE worker SET session_id = ?, updated_at = ? WHERE ticket_id = ?')
      .run(sessionId, new Date(this.now()).toISOString(), ticketId)
  }
  setPromptVersion(ticketId: string, promptVersion: string): void {
    this.store.db
      .prepare('UPDATE worker SET prompt_version = ?, updated_at = ? WHERE ticket_id = ?')
      .run(promptVersion, new Date(this.now()).toISOString(), ticketId)
  }
  /**
   * A record of another Assignment starts over from zero under assignmentId.
   * Returns the totals (the given values when there is no record).
   */
  addUsage(ticketId: string, assignmentId: string, turns: number, costUsd: number): { turns: number; costUsd: number } {
    this.store.db
      .prepare(
        `UPDATE worker SET turns = CASE WHEN assignment_id = ? THEN turns + ? ELSE ? END,
      cost_usd = CASE WHEN assignment_id = ? THEN cost_usd + ? ELSE ? END, assignment_id = ?, updated_at = ? WHERE ticket_id = ?`,
      )
      .run(
        assignmentId,
        turns,
        turns,
        assignmentId,
        costUsd,
        costUsd,
        assignmentId,
        new Date(this.now()).toISOString(),
        ticketId,
      )
    const record = this.get(ticketId)
    return record ? { turns: record.turns, costUsd: record.costUsd } : { turns, costUsd }
  }
}
