// Ported from dsh-superagent-prototype (MIT) src/infra/health.ts
export type Health = {
  state: 'starting' | 'ready' | 'paused' | 'error'
  detail: string
  at?: string
  code?: string
  values?: Record<string, string>
}

export interface HealthSnapshot {
  at: string
  pid: number
  entries: Record<string, Health>
}
export const HEALTH_SNAPSHOT_MS = 5_000

export interface HealthEntry {
  get(): Health | undefined
  set(health: Health): void
  /** Unregisters the entry; later `set` calls become no-ops. */
  release(): void
}

/** Health entries, each with one writer: `claim` throws when the name is already held. */
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
      set: health => {
        if (held) this.entries[name] = health
      },
      release: () => {
        if (!held) return
        held = false
        this.claimed.delete(name)
        delete this.entries[name]
      },
    }
  }
  get all(): Readonly<Record<string, Health>> {
    return this.entries
  }
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
  constructor(
    board: Pick<HealthBoard, 'snapshot'>,
    write: (snapshot: HealthSnapshot) => void,
    now = Date.now,
    intervalMs = HEALTH_SNAPSHOT_MS,
  ) {
    this.board = board
    this.write = write
    this.now = now
    this.intervalMs = intervalMs
  }
  record(force = false): boolean {
    const t = this.now()
    if (!force && this.last !== undefined && t - this.last < this.intervalMs) return false
    this.write(this.board.snapshot(new Date(t).toISOString()))
    this.last = t
    return true
  }
}
