// Ported from dsh-superagent-prototype (MIT) src/app/passes.ts
/** Periodic and on-demand orchestration passes that drive due effects and Engine evaluations. */
import type { Engine, ReceiveResult, Trigger } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Effects } from './effects.ts'

export const PASS_INTERVAL_MS = 2000

export interface Timers {
  setInterval(run: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const systemTimers: Timers = {
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: handle => {
    clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

export interface PassesHost {
  readonly engine: Pick<Engine, 'receive' | 'evaluateDue'>
  readonly effects: Pick<Effects, 'kick' | 'idle'>
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  readonly now?: () => number
  readonly timers?: Timers
  configured(): boolean
  closing(): boolean
  /** Runs at the end of every pass (retention evaluation and the health snapshot). */
  afterPass?(): void
}

/**
 * Serializes passes; sources and tools request immediate passes. A failed pass sets the health entry to error,
 * and the next successful pass clears it.
 */
export class Passes {
  private timer: unknown
  private stopped = false
  private pumping?: Promise<void>
  private pumpAgain?: Promise<void>
  private readonly host: PassesHost
  private readonly timers: Timers
  private readonly clock: () => number
  constructor(host: PassesHost) {
    this.host = host
    this.timers = host.timers ?? systemTimers
    this.clock = host.now ?? (() => Date.now())
  }
  start(): void {
    if (!this.stopped)
      this.timer = this.timers.setInterval(() => {
        this.request()
      }, PASS_INTERVAL_MS)
  }
  stop(): Promise<unknown> {
    this.stopped = true
    if (this.timer !== undefined) this.timers.clearInterval(this.timer)
    return Promise.allSettled([this.pumping, this.pumpAgain])
  }
  receive(trigger: Trigger): ReceiveResult {
    if (this.host.closing()) throw new Error('Orchestrator is stopping')
    const result = this.host.engine.receive(trigger)
    if (result === 'stored') this.request()
    return result
  }
  request(): void {
    const { health } = this.host
    this.pump().then(
      () => {
        if (health.get()?.state !== 'error' || this.host.lifetime.aborted) return
        health.set({ state: 'ready', detail: 'Orchestrator is ready', at: new Date(this.clock()).toISOString() })
      },
      (error: unknown) => {
        health.set({
          state: 'error',
          detail: `A pass failed: ${String(error)}`,
          at: new Date(this.clock()).toISOString(),
        })
      },
    )
  }
  /** Wait until no pass or effect that can start now is running. */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.pumping, this.pumpAgain])
      await this.host.effects.idle()
      if (!this.pumping && !this.pumpAgain) return
    }
  }
  /** Run one pass, coalescing concurrent callers into a single follow-up pass. */
  async pump(): Promise<void> {
    // Do not assess, dispatch, or send while waiting for setup; queued work waits for the restart that completes setup.
    if (!this.host.configured() || this.host.closing()) return
    if (!this.pumping)
      return (this.pumping = this.pumpOnce().finally(() => {
        this.pumping = undefined
      }))
    const next = () => {
      this.pumpAgain = undefined
      return this.pump()
    }
    return (this.pumpAgain ??= this.pumping.then(next, next))
  }
  private async pumpOnce(): Promise<void> {
    this.host.effects.kick()
    if (this.host.closing()) return
    // While processing is paused, the Engine only records the pause on active Evals so they do not expire.
    this.host.engine.evaluateDue()
    this.host.afterPass?.()
  }
}
