/** WorkerExecutor test harness: file Store, Effects, the Engine harness, FakeRuntime and a manual clock that drives Effects, worker timers and Fake delays. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { z } from 'zod'
import { Effects } from '../../src/app/effects.ts'
import { Store } from '../../src/app/store.ts'
import type { Ticket, WorkerReport } from '../../src/core/index.ts'
import type { ToolSpec } from '../../src/executor/contract.ts'
import { Slots } from '../../src/executor/slots.ts'
import { WorkerExecutor, type WorkerDeps } from '../../src/executor/worker-executor.ts'
import { WorkerStore } from '../../src/executor/worker-store.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { FakeRuntime, type FakeScript } from '../../src/runtimes/fake/runtime.ts'
import { deferred } from './async.ts'
import { harness } from './engine.ts'

export class ManualClock {
  private at: number
  private seq = 0
  private readonly due = new Map<number, { at: number; run: () => void }>()
  constructor(start = Date.parse('2026-09-23T00:00:00Z')) { this.at = start }
  now = (): number => this.at
  setTimeout = (run: () => void, ms: number): unknown => { const id = ++this.seq; this.due.set(id, { at: this.at + ms, run }); return id }
  clearTimeout = (handle: unknown): void => { this.due.delete(handle as number) }
  get pending(): number { return this.due.size }
  /** Moves time forward by ms, running each due callback in time order at its own time. */
  advance(ms: number): void {
    const end = this.at + ms
    for (;;) {
      let next: [number, { at: number; run: () => void }] | undefined
      for (const entry of this.due) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
      if (!next) break
      this.due.delete(next[0])
      this.at = next[1].at
      next[1].run()
    }
    this.at = end
  }
}
export interface WorkerHarnessOptions { script?: FakeScript; max?: number; limits?: { maxTurns: number; maxBudgetUsd: number }
  prepare?: WorkerDeps['prepare']; retries?: number; directory?: string; start?: boolean }
export function workerHarness(options: WorkerHarnessOptions = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'worker-'))
  const store = new Store(join(directory, 'db.sqlite'))
  const clock = new ManualClock()
  const effects = new Effects(store, new HealthBoard(), clock.now)
  const runtime = new FakeRuntime(options.script ?? (() => ({})), { timers: clock })
  const slots = new Slots(options.max ?? 2)
  const workers = new WorkerStore(store, clock.now)
  let h: Harness | undefined
  const prepare = vi.fn(options.prepare ?? (async (ticket: Ticket) => ({ repository: 'owner/repo', cwd: join(directory, 'work', ticket.id), branch: `agent/${ticket.id}` })))
  const tools = (ticket: Ticket): ToolSpec[] => [
    { name: 'wait', description: 'Wait briefly', schema: z.object({}), execute: async () => 'ok' },
    { name: 'report', description: 'Report the ticket status', schema: z.object({ state: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']), summary: z.string() }),
      execute: async args => { h!.engine.report(ticket.id, args as WorkerReport); return 'ok' } },
  ]
  const executor = new WorkerExecutor({
    store, effects, engine: () => h!.engine, runtime, slots, workers, deps: { prepare, instructions: async () => 'instructions', tools },
    limits: options.limits ?? { maxTurns: 100, maxBudgetUsd: 5 }, timers: clock, now: clock.now, ...(options.retries === undefined ? {} : { retries: options.retries }),
  })
  h = harness({}, { repo: store, executor })
  if (options.start !== false) effects.start()
  return { ...h, store, clock, effects, runtime, slots, workers, executor, prepare, directory, ticket: (id: string) => store.tickets.get(id)!,
    close: async () => { await executor.dispose(); await effects.drain(); store.close(); if (!options.directory) rmSync(directory, { recursive: true, force: true }) } }
}
type Harness = ReturnType<typeof harness>
/** Named gates: `get` returns a promise that resolves once `open` is called for the same name. */
interface Gate { promise: Promise<void>; resolve: (value: void) => void }
export function gates() {
  const map = new Map<string, Gate>()
  const of = (name: string): Gate => { let gate = map.get(name); if (!gate) { gate = deferred(); map.set(name, gate) } return gate }
  return { get: (name: string): Promise<void> => of(name).promise, open: (name: string): void => of(name).resolve() }
}
