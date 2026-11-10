/**
 * The composition root: Store → Engine (Policy, SourceScope, Assessor, WorkerExecutor, Outbox) → Source kinds → effect handlers → Passes → recovery. `start()` recovers interrupted work and starts the loops and Source services; `stop()` cleans up within STOP_TIMEOUT_MS. The assessor is deterministic and the worker workspace, instructions and tools are minimal stand-ins until the model runtime milestones.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Engine, UserError, type Assessor, type Candidate, type DomainEvent, type EngineForExecutor, type Ticket, type WorkerReport } from '../core/index.ts'
import type { AgentRuntime, ToolSpec } from '../executor/contract.ts'
import { recover } from '../executor/recovery.ts'
import { Slots } from '../executor/slots.ts'
import { WorkerExecutor, type WorkerDeps, type WorkerTimers } from '../executor/worker-executor.ts'
import { WorkerStore } from '../executor/worker-store.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { assessmentOutcome, settingsPolicy, type Assessment, type Settings } from '../policy/policy.ts'
import { sourceContext, type LogRecord, type LogSink, type SourceContext, type SourceHost, type SourceService } from '../sources/host.ts'
import type { SourceKind } from '../sources/kind.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { settingsOf, type Config } from './config.ts'
import { Effects } from './effects.ts'
import { Outbox, type OutboxChannels } from './outbox.ts'
import { Passes, type Timers as PassTimers } from './passes.ts'
import { databasePath, Store } from './store.ts'

export const STOP_TIMEOUT_MS = 10_000
export const WORKER_INSTRUCTIONS = 'Work on the assigned ticket in the current directory. When you finish, call orchestrator_report with state ready and a summary; the summary is sent to the conversation the ticket started in.'

export function jsonLines(write: (line: string) => void): LogSink {
  return record => { write(JSON.stringify(record) + '\n') }
}

/** The one worker tool. Report and reply run synchronously inside one tool call, so the session stop that a ready report causes cannot cut the reply off. */
export function workerTools(engine: () => Pick<EngineForExecutor, 'report' | 'reply'>, ticket: Ticket): ToolSpec[] {
  return [{
    name: 'orchestrator_report',
    description: 'Report the ticket state with a short summary; a ready report sends the summary as the result',
    schema: z.object({ state: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']), summary: z.string().trim().min(1).max(500) }),
    execute: async args => {
      const report = args as WorkerReport
      engine().report(ticket.id, report)
      if (report.state === 'ready') engine().reply({ purpose: 'result', ticketId: ticket.id, text: report.summary })
      return 'ok'
    },
  }]
}

export function deterministicAssessment(candidate: Candidate, settings: Settings): Assessment {
  const explicit = candidate.strength === 'explicit'
  const reason = explicit ? 'An allowed sender addressed the agent' : 'Only explicit requests are accepted without a model assessment'
  const primary = candidate.triggers.find(trigger => trigger.id === candidate.thread.evaluating?.primary) ?? candidate.triggers[0]
  const first = (primary?.text.trim() ?? '').split('\n')[0] ?? ''
  return {
    decision: explicit ? 'accept' : 'ignore',
    rule_assessments: settings.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched: explicit, reason })),
    direction: { implementation_requested: explicit, target_basis: explicit ? 'specified' : 'undetermined', requires_design_decision: false, evidence: reason },
    title: (first || 'Request').slice(0, 80),
    scope: 'As the request states',
    reason,
    intent_evidence: explicit ? reason : null,
  }
}

export interface GateAssessorHost {
  effects: Pick<Effects, 'handle' | 'enqueue' | 'cancel'>
  engine: () => Pick<Engine, 'candidate' | 'decide'>
  settings: () => Settings
}

export class GateAssessor implements Assessor {
  private readonly host: GateAssessorHost
  constructor(host: GateAssessorHost) {
    this.host = host
    host.effects.handle('assessment', (payload, evalId) => this.assess(payload.triggerId, evalId))
  }
  request(candidate: Candidate): void {
    const first = candidate.triggers[0]
    if (first) this.host.effects.enqueue('assessment', candidate.evalId, { triggerId: first.id })
  }
  release(evalId: string): void {
    this.host.effects.cancel('assessment', evalId)
  }
  private async assess(triggerId: string, evalId: string): Promise<void> {
    const candidate = this.host.engine().candidate(triggerId)
    if (candidate?.evalId !== evalId) return
    const settings = this.host.settings()
    const outcome = assessmentOutcome(deterministicAssessment(candidate, settings), settings, candidate.strength)
    try { this.host.engine().decide(triggerId, { ...outcome, evalId }) } catch (error) { if (!(error instanceof UserError)) throw error }
  }
}

export interface RuntimeOptions {
  config: Config
  runtime: AgentRuntime
  kinds?: readonly SourceKind[]
  services?: readonly SourceService[]
  log?: LogSink
  now?: () => number
  timers?: PassTimers & WorkerTimers
  stopTimeoutMs?: number
}

function eventRecord(event: DomainEvent): LogRecord {
  const data = event.data as Record<string, unknown>
  return {
    level: 'info', at: event.at, event: event.type,
    ...(typeof data.ticketId === 'string' ? { ticketId: data.ticketId } : {}),
    ...(typeof data.assignmentId === 'string' ? { assignmentId: data.assignmentId } : {}),
  }
}

function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => { resolve(false) }, Math.max(0, ms)) })
  return Promise.race([work.then(() => true, () => true), timeout]).finally(() => { clearTimeout(timer) })
}

export class Runtime implements SourceHost {
  readonly config: Config
  readonly store: Store
  readonly board: HealthBoard
  readonly sources: SourceRegistry
  readonly effects: Effects
  readonly outbox: Outbox
  readonly executor: WorkerExecutor
  readonly engine: Engine
  readonly passes: Passes
  private readonly agent: AgentRuntime
  private readonly log: LogSink
  private readonly now: () => number
  private readonly settings: Settings
  private readonly services: readonly SourceService[]
  private readonly running: SourceService[] = []
  private readonly disposers: (() => void)[] = []
  private readonly lifetime = new AbortController()
  private readonly health: HealthEntry
  private readonly stopTimeoutMs: number
  private closing = false
  private started = false
  private stopping?: Promise<void>

  constructor(options: RuntimeOptions) {
    const { config, timers } = options
    this.config = config
    this.agent = options.runtime
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
    this.services = options.services ?? []
    this.stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS
    const now = this.now
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
    const store = new Store(databasePath(config.stateDir), error => {
      this.log({ level: 'error', at: new Date(now()).toISOString(), event: 'store.error', detail: String(error) })
    })
    this.store = store
    try {
      const board = new HealthBoard()
      this.board = board
      this.health = board.claim('runtime', { state: 'starting', detail: 'Starting' })
      const effects = new Effects(store, board, now)
      this.effects = effects
      const settings = settingsOf(config)
      this.settings = settings
      const sources = new SourceRegistry(() => ({}), board)
      this.sources = sources
      for (const kind of options.kinds ?? []) this.disposers.push(sources.register(kind))
      const policy = settingsPolicy(settings, sources)
      const channels: OutboxChannels = {
        enabled: source => sources.enabled(source),
        allowed: channel => sources.channelAllowed(channel),
        send: message => sources.send(message),
      }
      this.outbox = new Outbox({ store, effects, channels, paused: () => policy.paused })
      const deps: WorkerDeps = {
        prepare: async ticket => {
          const origin = store.triggers.get(ticket.origin.triggerId)
          const repository = typeof origin?.meta.repository === 'string' ? origin.meta.repository : config.repositories[0]!
          const cwd = join(config.stateDir, 'work', ticket.id)
          mkdirSync(cwd, { recursive: true })
          return { repository, cwd, branch: `agent/${ticket.id}` }
        },
        instructions: async () => WORKER_INSTRUCTIONS,
        tools: ticket => workerTools(() => this.engine, ticket),
        env: () => ({}),
      }
      this.executor = new WorkerExecutor({
        store, effects, engine: () => this.engine, runtime: options.runtime, slots: new Slots(config.workers.max), workers: new WorkerStore(store, now), deps,
        limits: { maxTurns: config.workers.maxTurns, maxBudgetUsd: config.workers.maxBudgetUsd }, now, paused: () => policy.paused,
        health: board.claim('executor'), ...(timers ? { timers } : {}),
      })
      const assessor = new GateAssessor({ effects, engine: () => this.engine, settings: () => settings })
      this.engine = new Engine({
        repo: store, policy: () => policy, scope: sources, assessor, executor: this.executor, outbox: this.outbox,
        now: () => new Date(now()).toISOString(), emit: event => { this.log(eventRecord(event)) },
      })
      this.passes = new Passes({
        engine: this.engine, effects, health: this.health, lifetime: this.lifetime.signal, now, configured: () => true,
        closing: () => this.closing, ...(timers ? { timers } : {}),
      })
    } catch (error) {
      store.close()
      throw error
    }
  }

  context(kind: string): SourceContext {
    return sourceContext({
      store: this.store, outbox: this.outbox, engine: this.engine, sources: this.sources, log: this.log, now: this.now,
      receive: trigger => this.passes.receive(trigger),
    }, kind)
  }

  async start(): Promise<void> {
    if (this.closing) throw new Error('The runtime is stopping')
    if (this.started) return
    this.started = true
    recover({ tickets: this.store.tickets, engine: this.engine, executor: this.executor })
    this.passes.start()
    this.effects.start()
    for (const service of this.services) {
      await service.start(this, this.lifetime.signal)
      this.running.push(service)
    }
    this.health.set({ state: 'ready', detail: 'Orchestrator is ready', at: this.stamp() })
    this.log({
      level: 'info', at: this.stamp(), event: 'runtime.started', stateDir: this.config.stateDir, runtime: this.agent.id,
      sources: this.sources.kinds().map(kind => kind.kind),
    })
    this.passes.request()
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown()
    return this.stopping
  }

  private stamp(): string {
    return new Date(this.now()).toISOString()
  }

  private async shutdown(): Promise<void> {
    this.closing = true
    this.log({ level: 'info', at: this.stamp(), event: 'runtime.stopping' })
    const deadline = Date.now() + this.stopTimeoutMs
    let complete = true
    try {
      const passesStopped = this.passes.stop()
      this.lifetime.abort()
      complete = await within(Promise.allSettled([passesStopped, ...this.running.map(service => service.stop())]), deadline - Date.now())
      complete = await within(this.effects.drain(), deadline - Date.now()) && complete
      complete = await within(this.executor.dispose(), deadline - Date.now()) && complete
    } finally {
      for (const dispose of [...this.disposers].reverse()) {
        try { dispose() } catch {}
      }
      this.store.close()
      this.log({
        level: complete ? 'info' : 'warn', at: this.stamp(), event: 'runtime.stopped',
        ...(complete ? {} : { detail: 'Cleanup did not finish within the stop timeout' }),
      })
    }
  }
}
