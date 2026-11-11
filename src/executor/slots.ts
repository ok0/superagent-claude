/** Worker slots: max normal slots plus one extra slot kept for a person's message or a status request; a waiting wake takes a freed slot before a launch. Held in memory; restart recovery acquires again. */
/** Why a slot is wanted: a new launch or a wake of an existing ticket. */
export type SlotKind = 'launch' | 'wake'
/** In-memory worker slot accounting. */
export class Slots {
  readonly max: number
  private readonly held = new Map<string, 'normal' | 'extra'>()
  private readonly waiting = new Set<string>() // wakes refused for lack of a slot, until they get one or are released
  constructor(max: number) {
    this.max = max
  }
  /** Whether ticketId holds a slot now. A ticket that already holds one gets true without taking another. */
  acquire(ticketId: string, kind: SlotKind, human: boolean): boolean {
    if (this.held.has(ticketId)) return true
    let normal = 0
    for (const value of this.held.values()) if (value === 'normal') normal++
    if (kind === 'launch') {
      const waits = this.waiting.size - (this.waiting.has(ticketId) ? 1 : 0)
      if (normal + waits < this.max) {
        this.held.set(ticketId, 'normal')
        return true
      }
      return false
    }
    if (normal < this.max) {
      this.held.set(ticketId, 'normal')
      this.waiting.delete(ticketId)
      return true
    }
    if (human && ![...this.held.values()].includes('extra')) {
      this.held.set(ticketId, 'extra')
      this.waiting.delete(ticketId)
      return true
    }
    this.waiting.add(ticketId)
    return false
  }
  /** Frees ticketId's slot and forgets its waiting wake; idempotent. */
  release(ticketId: string): void {
    this.held.delete(ticketId)
    this.waiting.delete(ticketId)
  }
  /** Whether ticketId currently holds a slot. */
  holds(ticketId: string): boolean {
    return this.held.has(ticketId)
  }
  /** Number of slots currently held, normal and extra. */
  get used(): number {
    return this.held.size
  }
  /** How many more launches may start: max − normal held − waiting wakes, at least 0. */
  launchRoom(): number {
    let normal = 0
    for (const value of this.held.values()) if (value === 'normal') normal++
    return Math.max(0, this.max - normal - this.waiting.size)
  }
}
