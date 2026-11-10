/**
 * The composition root: Store → Engine (Policy, SourceScope, Assessor, WorkerExecutor, Outbox) → Source kinds → AdmissionFilter in front of Passes → effect handlers → recovery. `start()` recovers interrupted work and starts the loops and Source services; `stop()` cleans up within STOP_TIMEOUT_MS. `reload()` re-reads the config file while the runtime runs: the policy part is applied to the next Trigger, startup-only keys are reported and kept, and a refused file keeps the running config. The assessor is deterministic and the worker instructions are the assembled prompt; the worker workspace and tools are minimal stand-ins until the model runtime milestones.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Engine, UserError, type Assessor, type Candidate, type DomainEvent, type EngineForExecutor, type Policy, type Ticket, type WorkerReport } from '../core/index.ts'
import type { AgentRuntime, ToolSpec } from '../executor/contract.ts'
import { recover } from '../executor/recovery.ts'
import { Slots } from '../executor/slots.ts'
import { WorkerExecutor, type WorkerDeps, type WorkerTimers } from '../executor/worker-executor.ts'
import { WorkerStore } from '../executor/worker-store.ts'
import { HealthBoard, type Health, type HealthEntry } from '../infra/health.ts'
import { assessmentOutcome, policyEffects, policyVersion, settingsPolicy, type Assessment, type Settings } from '../policy/policy.ts'
import { AdmissionFilter } from '../sources/admission-filter.ts'
import { sourceContext, type LogRecord, type LogSink, type SourceContext, type SourceHost, type SourceService } from '../sources/host.ts'
import type { SourceKind } from '../sources/kind.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { loadConfig, settingsOf, StartupRefused, type Config } from './config.ts'
import { assertStartupPolicy, type StartupReport } from './credentials.ts'
import { Effects } from './effects.ts'
import { Outbox, type OutboxChannels } from './outbox.ts'
import { Passes, type Timers as PassTimers } from './passes.ts'
import { databasePath, Store } from './store.ts'
import { PromptVersions, Prompts, ruleLines } from './prompts.ts'

export const STOP_TIMEOUT_MS = 10_000

/** The config keys that take effect only on restart; a reload keeps the running value and reports the key. */
export const RESTART_KEYS = ['auth.mode', 'delivery', 'workers', 'network', 'security', 'retention', 'models', 'stateDir'] as const

export interface ReloadOutcome { applied: boolean; policyChanged: boolean; restartRequired: string[]; warnings: string[]; error?: string }

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
  /** Directory of the config file; team sections are read from <configDir>/prompts/team. */
  configDir?: string
  /** The config file that `reload` re-reads. */
  configPath?: string
  /** Environment for loading the config on reload (default process.env). */
  env?: Readonly<Record<string, string | undefined>>
  /** The startup report of the credential and policy checks; its warnings and consent are recorded in health and logs. */
  startup?: StartupReport
  /** The agent account login once the Source read it; reload checks it against policy.allowed. */
  agentLogin?: () => string | undefined
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

function authState(mode: Config['auth']['mode'], report: StartupReport | undefined, at: string): Health {
  return {
    state: 'ready',
    detail: report?.warnings.length ? report.warnings.join(' ') : `Authentication mode ${mode}`,
    at,
    values: { mode, ...(report?.consent ? { consentAt: report.consent.at, allowedHash: report.consent.allowedHash } : {}) },
  }
}

function pick(config: Config, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], config)
}

export class Runtime implements SourceHost {
  readonly store: Store
  readonly board: HealthBoard
  readonly sources: SourceRegistry
  readonly effects: Effects
  readonly outbox: Outbox
  readonly executor: WorkerExecutor
  readonly engine: Engine
  readonly passes: Passes
  readonly prompts: Prompts
  private current: Config
  get config(): Config { return this.current }
  private readonly agent: AgentRuntime
  private readonly log: LogSink
  private readonly now: () => number
  private settings: Settings
  private policy!: Policy
  private readonly admission: AdmissionFilter
  private readonly services: readonly SourceService[]
  private readonly running: SourceService[] = []
  private readonly disposers: (() => void)[] = []
  private readonly lifetime = new AbortController()
  private readonly health: HealthEntry
  private readonly authHealth: HealthEntry
  private readonly configHealth: HealthEntry
  private consentHash?: string
  private reloads: Promise<unknown> = Promise.resolve()
  private readonly configPath: string | undefined
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly agentLogin: (() => string | undefined) | undefined
  private readonly stopTimeoutMs: number
  private closing = false
  private started = false
  private stopping?: Promise<void>

  constructor(options: RuntimeOptions) {
    const { config, timers } = options
    this.current = config
    this.agent = options.runtime
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
    this.configPath = options.configPath
    this.env = options.env ?? process.env
    this.agentLogin = options.agentLogin
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
      this.configHealth = board.claim('config', { state: 'ready', detail: 'Config loaded' })
      this.authHealth = board.claim('auth', authState(config.auth.mode, options.startup, this.stamp()))
      this.recordAuth(options.startup)
      const effects = new Effects(store, board, now)
      this.effects = effects
      const settings = settingsOf(config)
      this.settings = settings
      this.prompts = new Prompts({ versions: new PromptVersions(store, now), ...(options.configDir === undefined ? {} : { teamDir: join(options.configDir, 'prompts', 'team') }), rules: () => ruleLines(this.settings.policy.rules) })
      this.prompts.baseline('worker')
      const sources = new SourceRegistry(() => ({}), board)
      this.sources = sources
      for (const kind of options.kinds ?? []) this.disposers.push(sources.register(kind))
      this.policy = settingsPolicy(settings, sources)
      const channels: OutboxChannels = {
        enabled: source => sources.enabled(source),
        allowed: channel => sources.channelAllowed(channel),
        send: message => sources.send(message),
      }
      this.outbox = new Outbox({ store, effects, channels, paused: () => this.policy.paused })
      const deps: WorkerDeps = {
        prepare: async ticket => {
          const origin = store.triggers.get(ticket.origin.triggerId)
          const repository = typeof origin?.meta.repository === 'string' ? origin.meta.repository : config.repositories[0]!
          const cwd = join(config.stateDir, 'work', ticket.id)
          mkdirSync(cwd, { recursive: true })
          return { repository, cwd, branch: `agent/${ticket.id}` }
        },
        instructions: async ticket => this.prompts.instructions('worker', [{ source: 'ticket-title', text: ticket.title }]),
        tools: ticket => workerTools(() => this.engine, ticket),
        env: () => ({}),
        promptVersion: () => this.prompts.version('worker'),
      }
      this.executor = new WorkerExecutor({
        store, effects, engine: () => this.engine, runtime: options.runtime, slots: new Slots(config.workers.max), workers: new WorkerStore(store, now), deps,
        limits: { maxTurns: config.workers.maxTurns, maxBudgetUsd: config.workers.maxBudgetUsd }, now, paused: () => this.policy.paused,
        health: board.claim('executor'), ...(timers ? { timers } : {}),
      })
      effects.handle('notice', async payload => {
        const { target, ticketId, id, text } = payload.value
        if (target === 'worker' && typeof ticketId === 'string' && typeof id === 'string' && typeof text === 'string') this.executor.notify(ticketId, { id, text })
      })
      const assessor = new GateAssessor({ effects, engine: () => this.engine, settings: () => this.settings })
      this.engine = new Engine({
        repo: store, policy: () => this.policy, scope: sources, assessor, executor: this.executor, outbox: this.outbox,
        now: () => new Date(now()).toISOString(), emit: event => { this.log(eventRecord(event)) },
      })
      this.passes = new Passes({
        engine: this.engine, effects, health: this.health, lifetime: this.lifetime.signal, now, configured: () => true,
        closing: () => this.closing, ...(timers ? { timers } : {}),
      })
      this.admission = new AdmissionFilter({
        next: trigger => this.passes.receive(trigger),
        store,
        rule: () => ({ allowed: this.current.policy.allowed, repositories: this.current.repositories }),
        rejected: entry => {
          this.log({ level: 'info', at: this.stamp(), event: 'admission.rejected', triggerId: entry.triggerId, repository: entry.repository, actor: entry.actor, reason: entry.reason })
        },
      })
    } catch (error) {
      store.close()
      throw error
    }
  }

  context(kind: string): SourceContext {
    return sourceContext({
      store: this.store, outbox: this.outbox, engine: this.engine, sources: this.sources, log: this.log, now: this.now,
      receive: trigger => this.admission.receive(trigger),
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

  /** Re-reads the config file and applies it: the policy part from the next Trigger on (a changed policy version is an input to open tickets), startup-only keys are kept and reported. A refused file changes nothing. Calls are serialised. */
  reload(): Promise<ReloadOutcome> {
    const next = this.reloads.then(() => this.reloadOnce())
    this.reloads = next.catch(() => undefined)
    return next
  }

  /** Reassembles the worker prompt; when its team sections or rules changed, queues a notice with the changed sections for every open worker session (same key per ticket: only the latest is delivered). Returns the number queued. M10 calls it on reload. */
  refreshPrompts(): number {
    const change = this.prompts.refresh('worker')
    if (!change?.notice) return 0
    const tickets = this.executor.liveTickets()
    const notice = change.notice
    this.store.atomic(() => {
      for (const ticketId of tickets) this.effects.enqueue('notice', `worker-prompts:${ticketId}`, { value: { target: 'worker', ticketId, id: `notice:prompts:${change.current.hash}`, text: notice }, summary: `Prompt version ${change.current.hash.slice(0, 12)}` })
    })
    return tickets.length
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown()
    return this.stopping
  }

  private stamp(): string {
    return new Date(this.now()).toISOString()
  }

  private recordAuth(report?: StartupReport): void {
    const mode = this.current.auth.mode
    for (const detail of report?.warnings ?? []) this.log({ level: 'warn', at: this.stamp(), event: 'auth.warning', detail })
    if (report?.consent && report.consent.allowedHash !== this.consentHash) {
      this.log({ level: 'warn', at: this.stamp(), event: 'auth.consent', mode, consentAt: report.consent.at, allowedHash: report.consent.allowedHash })
      this.consentHash = report.consent.allowedHash
    }
    if (!report?.consent) this.consentHash = undefined
    this.authHealth.set(authState(mode, report, this.stamp()))
  }

  private fail(message: string): ReloadOutcome {
    const at = this.stamp()
    this.log({ level: 'error', at, event: 'config.reload_failed', detail: message })
    this.configHealth.set({ state: 'error', detail: message, at })
    return { applied: false, policyChanged: false, restartRequired: [], warnings: [], error: message }
  }

  private async reloadOnce(): Promise<ReloadOutcome> {
    if (this.closing) return this.fail('The runtime is stopping')
    if (this.configPath === undefined) return this.fail('No config file to reload')
    const path = this.configPath
    let next: Config
    try {
      next = loadConfig(path, this.env)
    } catch (error) {
      if (error instanceof StartupRefused) return this.fail(error.message)
      throw error
    }
    const effective: Config = {
      ...this.current,
      repositories: next.repositories,
      policy: next.policy,
      auth: {
        mode: this.current.auth.mode,
        acceptSubscriptionSharedUseRisk: next.auth.acceptSubscriptionSharedUseRisk,
        ...(next.auth.owner === undefined ? {} : { owner: next.auth.owner }),
      },
    }
    const restartRequired = RESTART_KEYS.filter(key => JSON.stringify(pick(next, key)) !== JSON.stringify(pick(this.current, key)))
    let report: StartupReport
    try {
      report = assertStartupPolicy(effective, { mode: this.current.auth.mode }, this.agentLogin?.(), await this.agent.probe(), this.now)
    } catch (error) {
      if (error instanceof StartupRefused) return this.fail(error.message)
      throw error
    }
    const configWarnings: string[] = []
    const beforeRepositories = new Set(this.current.repositories.map(repository => repository.toLowerCase()))
    const afterRepositories = new Set(next.repositories.map(repository => repository.toLowerCase()))
    if (beforeRepositories.size !== afterRepositories.size || [...afterRepositories].some(repository => !beforeRepositories.has(repository))) {
      configWarnings.push('Repository list changes apply to admission now; polling targets change on restart')
    }
    const before = this.settings
    const after = settingsOf(effective)
    const from = policyVersion(before)
    const to = policyVersion(after)
    this.current = effective
    this.settings = after
    this.policy = settingsPolicy(after, this.sources)
    if (from !== to) this.engine.policyChanged(from, to, policyEffects(this.store.tickets.open(), before, after, () => this.sources))
    const at = this.stamp()
    this.recordAuth(report)
    if (restartRequired.length) this.log({ level: 'warn', at, event: 'config.restart_required', keys: restartRequired })
    for (const detail of configWarnings) this.log({ level: 'warn', at, event: 'config.warning', detail })
    this.log({ level: 'info', at, event: 'config.reloaded', policyChanged: from !== to })
    this.configHealth.set({ state: 'ready', detail: 'Config reloaded', at })
    this.refreshPrompts()
    this.passes.request()
    return { applied: true, policyChanged: from !== to, restartRequired: [...restartRequired], warnings: [...report.warnings, ...configWarnings] }
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
