// Ported from dsh-superagent-prototype (MIT) src/infra/health.ts
/**
 * Component health registry read by the status CLI.
 * Changes from the reference: the `Health` type moves here from `sources/host.ts` with an optional `code`; the docs are reworded; a snapshot of all entries and a HealthRecorder that writes it at most every HEALTH_SNAPSHOT_MS for the status CLI are added.
 */
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: string; values?: Record<string, string> }

/** The whole board as the status CLI reads it: when it was taken, by which daemon process, and every entry. */
export interface HealthSnapshot { at: string; pid: number; entries: Record<string, Health> }
/** Minimum time between two health snapshot writes by a HealthRecorder. */
export const HEALTH_SNAPSHOT_MS = 5_000

export interface HealthEntry {
  get(): Health | undefined
  set(health: Health): void
  /** Unregisters the entry from the board (such as when a Source kind unregisters); subsequent `set` calls become no-ops. */
  release(): void
}

/**
 * Central registry of component health entries, enforcing single-writer ownership per entry name.
 * Claimed by the Runtime, Effects, WorkerExecutor, RouterHost and Sources, and read by the status CLI.
 */
export class HealthBoard {
  private readonly entries: Record<string, Health> = {}
  private readonly claimed = new Set<string>()
  claim(name: string, initial?: Health): HealthEntry {
    if (this.claimed.has(name)) throw new Error(`The health entry ${name} is reported by another part`)
    this.claimed.add(name)
    if (initial) this.entries[name] = initial
    let held = true
    return {
      get: () => this.entries[name],
      set: health => { if (held) this.entries[name] = health },
      release: () => {
        if (!held) return
        held = false
        this.claimed.delete(name)
        delete this.entries[name]
      },
    }
  }
  get all(): Readonly<Record<string, Health>> { return this.entries }
  snapshot(at: string): HealthSnapshot {
    return { at, pid: process.pid, entries: JSON.parse(JSON.stringify(this.entries)) as Record<string, Health> }
  }
}

/** Writes a board snapshot at most once per `intervalMs`, unless forced. */
export class HealthRecorder {
  private readonly board: Pick<HealthBoard, 'snapshot'>
  private readonly write: (snapshot: HealthSnapshot) => void
  private readonly now: () => number
  private readonly intervalMs: number
  private last?: number
  constructor(board: Pick<HealthBoard, 'snapshot'>, write: (snapshot: HealthSnapshot) => void, now = Date.now, intervalMs = HEALTH_SNAPSHOT_MS) {
    this.board = board
    this.write = write
    this.now = now
    this.intervalMs = intervalMs
  }
  /** Returns true when a snapshot was written. */
  record(force = false): boolean {
    const t = this.now()
    if (!force && this.last !== undefined && t - this.last < this.intervalMs) return false
    this.write(this.board.snapshot(new Date(t).toISOString()))
    this.last = t
    return true
  }
}
