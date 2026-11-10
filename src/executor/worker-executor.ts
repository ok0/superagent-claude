/** WorkerExecutor: the core Executor over an AgentRuntime. start, deliver and stop only queue work; launch and delivery effect handlers take a slot, prepare the workspace, open or resume the worker session, and report its events to the Engine; limits, retries and background work are enforced here (ADR-3, ADR-6, ADR-17). */
import { Later, type Effects } from '../app/effects.ts'
import type { Store } from '../app/store.ts'
import { key, latestAssignment, runningAssignment, UserError, type Assignment, type EngineForExecutor, type Executor, type Ticket,
  type TicketInput, type Trigger, type WorkerReport } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import { ReadLedger, type AgentRuntime, type AgentSession, type InputMode, type RuntimeEvent, type RuntimeInput, type SessionSpec,
  type ToolSpec } from './contract.ts'
import type { Slots } from './slots.ts'
import type { WorkerStore } from './worker-store.ts'

export const RUNTIME_RETRIES = 3
export const RETRY_BACKOFF_MS = 15_000
export const BACKGROUND_LIMIT_MS = 30 * 60_000
export const workerKey = (ticketId: string): string => `worker-${ticketId}`
export interface Workspace { repository: string; cwd: string; branch: string; pushRemote?: string }
/** Injected collaborators: the workspace (M12), the instructions (M13) and the worker tools (M8/M11). */
export interface WorkerDeps {
  prepare(ticket: Ticket): Promise<Workspace>
  instructions(ticket: Ticket): Promise<string>
  tools(ticket: Ticket, assignment: Assignment): ToolSpec[]
  env?(ticket: Ticket): Record<string, string>
  promptVersion?(): string
}
export interface WorkerTimers { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export interface WorkerExecutorOptions {
  store: Pick<Store, 'tickets' | 'triggers' | 'afterCommit'>
  effects: Pick<Effects, 'enqueue' | 'handle' | 'cancel' | 'kick'>
  engine: () => EngineForExecutor
  runtime: AgentRuntime; slots: Slots; workers: WorkerStore; deps: WorkerDeps
  limits: { maxTurns: number; maxBudgetUsd: number }
  network?: string[]; model?: string
  retries?: number; retryBackoffMs?: number; backgroundLimitMs?: number
  timers?: WorkerTimers; now?: () => number; paused?: () => boolean
  health?: Pick<HealthEntry, 'set'>
}
/** Mode of a ticket Input (see docs/runtime-contract.md): a person's message steers; notes and legacy reopen markers are injected; everything else is a followup. */
export function inputMode(input: TicketInput): InputMode {
  switch (input.kind) {
    case 'trigger': return input.human ? 'steer' : 'followup'
    case 'note': case 'reopen': return 'inject'
    case 'text': case 'policy-changed': case 'resumed': return 'followup'
  }
}
/** Worker-facing text of an Input; undefined for a legacy reopen marker, which is marked delivered without being sent. */
export function renderInput(input: TicketInput, trigger?: Trigger): string | undefined {
  switch (input.kind) {
    case 'trigger':
      return trigger
        ? JSON.stringify({ trigger_id: input.triggerId, from: trigger.actor.id, at: trigger.at, text: trigger.text, ...(input.context ? { context: true } : {}),
          ...(input.note ? { routing_note: input.note } : {}) })
        : JSON.stringify({ trigger_id: input.triggerId })
    case 'text': return input.text
    case 'note': return `Note for context only: ${input.text}`
    case 'policy-changed': return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
    case 'resumed': return 'This ticket ended earlier and the message that follows resumed it under the same mandate. Continue within the original scope and report when done.'
    case 'reopen': return undefined
  }
}

interface Live {
  ticketId: string; assignmentId: string; session: AgentSession; reads: ReadLedger; outstanding: Map<string, InputMode>
  lastActivity: number; background?: unknown; timers: Set<unknown>
}

export class WorkerExecutor implements Executor {
  private readonly live = new Map<string, Live>()
  private readonly launching = new Set<string>()
  private readonly failures = new Map<string, number>()
  private readonly store: Pick<Store, 'tickets' | 'triggers' | 'afterCommit'>
  private readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'cancel' | 'kick'>
  private readonly engine: () => EngineForExecutor
  private readonly runtime: AgentRuntime
  private readonly slots: Slots
  private readonly workers: WorkerStore
  private readonly deps: WorkerDeps
  private readonly limits: { maxTurns: number; maxBudgetUsd: number }
  private readonly network: string[]
  private readonly model: string | undefined
  private readonly retries: number
  private readonly retryBackoffMs: number
  private readonly backgroundLimitMs: number
  private readonly timers: WorkerTimers
  private readonly now: () => number
  private readonly paused: () => boolean
  private readonly health: Pick<HealthEntry, 'set'> | undefined

  constructor(options: WorkerExecutorOptions) {
    this.store = options.store
    this.effects = options.effects
    this.engine = options.engine
    this.runtime = options.runtime
    this.slots = options.slots
    this.workers = options.workers
    this.deps = options.deps
    this.limits = options.limits
    this.network = options.network ?? []
    this.model = options.model
    this.retries = options.retries ?? RUNTIME_RETRIES
    this.retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS
    this.backgroundLimitMs = options.backgroundLimitMs ?? BACKGROUND_LIMIT_MS
    this.timers = options.timers ?? { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout) }
    this.now = options.now ?? Date.now
    this.paused = options.paused ?? (() => false)
    this.health = options.health
    this.effects.handle('launch', payload => this.launch(payload), { limit: () => this.paused() ? 0 : this.slots.launchRoom() + this.launching.size, retry: [5000, 300_000] })
    this.effects.handle('delivery', payload => this.delivery(payload), { limit: () => this.paused() ? 0 : 4, quiet: true })
  }

  start(ticket: Ticket, assignment: Assignment): void {
    this.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  deliver(ticket: Ticket): void {
    this.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id })
  }
  stop(ticket: Ticket, assignment: Assignment, _reason: string): void {
    this.effects.cancel('launch', assignment.id)
    this.store.afterCommit(() => { void this.halt(ticket.id, assignment.id) })
  }

  private current(ticketId: string, assignmentId: string): boolean {
    const ticket = this.store.tickets.get(ticketId)
    const latest = ticket && latestAssignment(ticket)
    return !!ticket && !ticket.ended && latest?.id === assignmentId && latest.state !== 'ended'
  }
  private running(ticketId: string, assignmentId: string): boolean {
    const ticket = this.store.tickets.get(ticketId)
    return !!ticket && !ticket.ended && runningAssignment(ticket)?.id === assignmentId
  }
  private report(ticketId: string, r: WorkerReport): void {
    try { this.engine().report(ticketId, { ...r, summary: r.summary.slice(0, 500) }) } catch (e) { if (!(e instanceof UserError)) this.problem(e) }
  }
  private problem(e: unknown): void {
    this.health?.set({ state: 'error', detail: String(e), at: new Date(this.now()).toISOString() })
  }
  private send(live: Live, input: RuntimeInput): void {
    live.session.send(input)
    live.outstanding.set(input.id, input.mode)
  }
  private detach(live: Live): void {
    if (this.live.get(live.ticketId) === live) this.live.delete(live.ticketId)
    for (const handle of live.timers) this.timers.clearTimeout(handle)
    if (live.background !== undefined) this.timers.clearTimeout(live.background)
  }
  private async release(live: Live): Promise<void> {
    await live.session.close().catch(() => {})
    this.slots.release(live.ticketId)
    this.effects.kick()
  }
  private attach(ticketId: string, assignmentId: string, session: AgentSession): Live {
    const live: Live = { ticketId, assignmentId, session, reads: new ReadLedger(), outstanding: new Map(), lastActivity: this.now(), timers: new Set() }
    this.live.set(ticketId, live)
    void this.loop(live)
    return live
  }
  private async spec(ticket: Ticket, assignment: Assignment, cwd: string, resume?: string): Promise<SessionSpec> {
    return {
      key: workerKey(ticket.id), role: 'worker', cwd, instructions: await this.deps.instructions(ticket), tools: this.deps.tools(ticket, assignment),
      builtins: { fs: 'write', shell: true, web: false }, network: { allow: [...this.network] }, limits: { ...this.limits },
      env: this.deps.env?.(ticket) ?? {}, ...(resume ? { resume } : {}), ...(this.model ? { model: this.model } : {}),
    }
  }
  private batch(ticket: Ticket): TicketInput[] {
    const inputs = ticket.undelivered.flatMap(id => ticket.inputs.filter(input => input.id === id))
    const last = inputs.findLastIndex(input => inputMode(input) !== 'inject')
    return last < 0 ? [] : inputs.slice(0, last + 1)
  }
  private assignmentMessage(ticket: Ticket, resumed: boolean): string {
    if (resumed) return JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length })
    const origin = this.store.triggers.get(ticket.origin.triggerId)
    return JSON.stringify({
      ticket_id: ticket.id, title: ticket.title, ...(ticket.execution?.assignment ? { assignment: ticket.execution.assignment } : {}),
      ...(origin ? { trigger: { trigger_id: origin.id, from: origin.actor.id, at: origin.at, text: origin.text } } : {}),
    })
  }
  private retryText(message: string): string {
    return `Your last turn failed for a passing reason (${message.slice(0, 200)}). Continue the assignment where it stopped.`
  }
  private message(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  private async launch({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || ticket.ended || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    if (!this.slots.acquire(ticketId, 'launch', false)) throw new Later('No worker slot is free')
    this.launching.add(ticketId)
    let attached = false
    let session: AgentSession | undefined
    try {
      const previous = this.live.get(ticketId)
      if (previous) { this.detach(previous); await previous.session.close().catch(() => {}) }
      const record = this.workers.get(ticketId)
      let workspace: Workspace
      try { workspace = await this.deps.prepare(ticket) } catch (e) {
        this.report(ticketId, { state: 'failed', summary: `The workspace could not be prepared: ${this.message(e)}` })
        return
      }
      if (!this.current(ticketId, assignmentId)) return
      const resume = record?.sessionId ?? undefined
      session = await this.runtime.open(await this.spec(ticket, assignment, workspace.cwd, resume))
      if (!this.current(ticketId, assignmentId)) return
      const same = record?.assignmentId === assignmentId
      this.workers.put({
        ticketId, assignmentId, runtime: this.runtime.id, sessionId: session.sessionId ?? resume ?? null, repository: workspace.repository,
        cwd: workspace.cwd, branch: workspace.branch, pushRemote: workspace.pushRemote ?? null, turns: same ? record.turns : 0,
        costUsd: same ? record.costUsd : 0, promptVersion: this.deps.promptVersion?.() ?? null,
      })
      const live = this.attach(ticketId, assignmentId, session)
      attached = true
      const fresh = this.store.tickets.get(ticketId)!
      const noteId = key('input', ticketId, 'restart', assignmentId)
      const note = fresh.undelivered.includes(noteId) ? fresh.inputs.find(input => input.id === noteId) : undefined
      const noteSent = note?.kind === 'text'
      if (note?.kind === 'text') this.send(live, { id: noteId, text: note.text, mode: 'followup' })
      this.send(live, { id: `assignment:${assignmentId}`, text: this.assignmentMessage(fresh, !!resume), mode: 'followup' })
      this.engine().assignmentStarted(ticketId, assignmentId)
      if (noteSent) this.engine().inputsDelivered(ticketId, assignmentId, [noteId])
    } catch (e) {
      if (e instanceof Later) throw e
      this.report(ticketId, { state: 'failed', summary: `The launch failed: ${this.message(e)}` })
    } finally {
      this.launching.delete(ticketId)
      if (!attached) {
        if (session) await session.close().catch(() => {})
        this.slots.release(ticketId)
        this.effects.kick()
      }
    }
  }

  private async delivery({ ticketId }: { ticketId: string }): Promise<void> {
    const first = this.store.tickets.get(ticketId)
    const target = first && !first.ended ? runningAssignment(first) : undefined
    if (!first || !target || !this.batch(first).length) return
    let live = this.live.get(ticketId)
    if (live && live.assignmentId !== target.id) {
      this.detach(live)
      await live.session.close().catch(() => {})
      live = undefined
    }
    let woken = false
    if (!live) {
      const human = this.batch(first).some(input => input.kind === 'trigger' && input.human === true)
      if (!this.slots.acquire(ticketId, 'wake', human)) throw new Later('No worker slot is free')
      let session: AgentSession
      let resume: string | undefined
      try {
        const record = this.workers.get(ticketId)
        const cwd = record?.cwd ?? (await this.deps.prepare(first)).cwd
        resume = record?.sessionId ?? undefined
        session = await this.runtime.open(await this.spec(first, target, cwd, resume))
      } catch (e) {
        this.slots.release(ticketId)
        this.effects.kick()
        this.engine().deliveryFailed(ticketId, target.id, this.message(e))
        throw e
      }
      if (!this.running(ticketId, target.id)) {
        await session.close().catch(() => {})
        this.slots.release(ticketId)
        this.effects.kick()
        return
      }
      if (session.sessionId && session.sessionId !== resume) this.workers.setSession(ticketId, session.sessionId)
      live = this.attach(ticketId, target.id, session)
      woken = true
      if (!resume) this.send(live, { id: `assignment:${target.id}`, text: this.assignmentMessage(first, false), mode: 'followup' })
    }
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket || !this.running(ticketId, target.id)) return
    const inputs = this.batch(ticket)
    if (!inputs.length) {
      if (woken) {
        this.detach(live)
        await this.release(live)
      }
      return
    }
    try {
      for (const input of inputs) {
        const text = renderInput(input, input.kind === 'trigger' ? this.store.triggers.get(input.triggerId) : undefined)
        if (text !== undefined) this.send(live, { id: input.id, text, mode: inputMode(input) })
      }
    } catch (e) {
      this.engine().deliveryFailed(ticketId, target.id, this.message(e))
      throw e
    }
    this.engine().inputsDelivered(ticketId, target.id, inputs.map(input => input.id))
  }

  private async loop(live: Live): Promise<void> {
    try {
      for await (const event of live.session.events()) {
        if (event.type === 'closed') break
        if (this.live.get(live.ticketId) !== live) continue
        try { await this.on(live, event) } catch (e) { this.problem(e) }
      }
    } catch (e) { this.problem(e) }
    finally {
      if (this.live.get(live.ticketId) === live) {
        this.detach(live)
        this.slots.release(live.ticketId)
        this.effects.kick()
      }
    }
  }
  private async on(live: Live, event: RuntimeEvent): Promise<void> {
    live.lastActivity = this.now()
    const { ticketId, assignmentId } = live
    switch (event.type) {
      case 'session':
        this.workers.setSession(ticketId, event.sessionId)
        return
      case 'inputsRead': {
        for (const id of event.ids) live.outstanding.delete(id)
        const fresh = live.reads.fresh(event.ids)
        if (fresh.length) this.engine().inputsRead(ticketId, fresh)
        return
      }
      case 'turnEnded': {
        const usage = this.workers.addUsage(ticketId, assignmentId, event.turns, event.costUsd)
        this.engine().turnEnded(ticketId, assignmentId)
        const limit = event.outcome === 'max_turns' || usage.turns > this.limits.maxTurns ? 'turn limit'
          : event.outcome === 'budget' || usage.costUsd > this.limits.maxBudgetUsd ? 'budget limit' : undefined
        if (limit) {
          this.detach(live)
          await live.session.interrupt().catch(() => ({ stillQueued: [] }))
          this.report(ticketId, { state: 'blocked', summary: limit })
          await this.release(live)
          return
        }
        if (event.outcome === 'error') {
          this.detach(live)
          this.report(ticketId, { state: 'failed', summary: 'The runtime ended the turn with an error' })
          await this.release(live)
          return
        }
        this.failures.delete(assignmentId)
        if (event.background > 0) {
          if (live.background === undefined) this.watch(live, this.backgroundLimitMs)
          return
        }
        if (live.background !== undefined) {
          this.timers.clearTimeout(live.background)
          live.background = undefined
        }
        if (!this.hasWork(live)) {
          this.detach(live)
          await this.release(live)
        }
        return
      }
      case 'error': {
        const tries = this.failures.get(assignmentId) ?? 0
        if (event.retryable && tries < this.retries) {
          this.failures.set(assignmentId, tries + 1)
          const h = this.timers.setTimeout(() => {
            live.timers.delete(h)
            if (this.live.get(ticketId) !== live) return
            try { this.send(live, { id: `retry:${assignmentId}:${tries + 1}`, text: this.retryText(event.message), mode: 'followup' }) } catch (e) { this.problem(e) }
          }, this.retryBackoffMs * 2 ** tries)
          live.timers.add(h)
        } else {
          this.failures.delete(assignmentId)
          this.detach(live)
          this.report(ticketId, { state: 'failed', summary: event.message })
          await this.release(live)
        }
        return
      }
      case 'closed':
        return
    }
  }
  private hasWork(live: Live): boolean {
    const ticket = this.store.tickets.get(live.ticketId)
    return [...live.outstanding.values()].some(mode => mode !== 'inject') || (!!ticket && this.batch(ticket).length > 0)
  }
  private watch(live: Live, ms: number): void {
    live.background = this.timers.setTimeout(() => {
      live.background = undefined
      if (this.live.get(live.ticketId) !== live) return
      const left = live.lastActivity + this.backgroundLimitMs - this.now()
      if (left > 0) { this.watch(live, left); return }
      void (async () => {
        this.detach(live)
        await live.session.interrupt().catch(() => {})
        await this.release(live)
      })()
    }, ms)
  }
  private async halt(ticketId: string, assignmentId: string): Promise<void> {
    try {
      this.failures.delete(assignmentId)
      const l = this.live.get(ticketId)
      if (l?.assignmentId === assignmentId) {
        this.detach(l)
        await l.session.interrupt().catch(() => {})
        await this.release(l)
      } else if (!l && !this.launching.has(ticketId)) {
        this.slots.release(ticketId)
        this.effects.kick()
      }
    } catch (e) { this.problem(e) }
  }

  async dispose(): Promise<void> {
    for (const live of [...this.live.values()]) {
      this.detach(live)
      await live.session.close().catch(() => {})
      this.slots.release(live.ticketId)
    }
  }
}
