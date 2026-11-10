/**
 * Hosts the Router session: opens it once per prompt version, resumes it by session id after a close,
 * and delivers relays (steer) and notices (inject) under idempotent input ids until the session reads them.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthEntry } from '../infra/health.ts'
import type { AgentRuntime, AgentSession, RuntimeInput, SessionSpec, ToolSpec } from './contract.ts'
import type { PromptChange } from './worker-executor.ts'

export const ROUTER_KEY = 'router'
export const REOPEN_LIMIT = 3
export const ROUTER_CONTEXT_NOTE = 'The host instructions changed since the earlier Router session, so this is a new session with the current instructions. Read open work with orchestrator_read tickets before deciding; do not repeat replies or decisions already recorded.'

export interface RouterRecord { sessionId: string | null; promptVersion: string | null }

export interface RouterDeps {
  instructions(): string
  tools(): ToolSpec[]
  promptVersion(): string
  promptChange(stored: string): PromptChange
  record: { get(): RouterRecord | undefined; put(record: RouterRecord): void }
  env?(): Record<string, string>
}

export interface RouterHostOptions {
  runtime: AgentRuntime
  stateDir: string
  deps: RouterDeps
  limits: { maxTurns: number; maxBudgetUsd: number }
  model?: () => string | undefined
  health?: Pick<HealthEntry, 'set'>
  now?: () => number
}

export class RouterHost {
  readonly cwd: string
  private readonly options: RouterHostOptions
  private session?: AgentSession
  private opening?: Promise<void>
  private readonly read = new Set<string>()
  private readonly unread = new Map<string, RuntimeInput>()
  private closing = false
  private failures = 0

  constructor(options: RouterHostOptions) {
    this.options = options
    this.cwd = join(options.stateDir, 'router')
    mkdirSync(this.cwd, { recursive: true, mode: 0o700 })
  }

  get sessionId(): string | undefined {
    return this.session?.sessionId
  }

  spec(resume?: string): SessionSpec {
    const model = this.options.model?.()
    return {
      key: ROUTER_KEY,
      role: 'router',
      cwd: this.cwd,
      instructions: this.options.deps.instructions(),
      tools: this.options.deps.tools(),
      builtins: { fs: 'none', shell: false, web: false },
      network: { allow: [] },
      limits: { ...this.options.limits },
      env: this.options.deps.env?.() ?? {},
      ...(resume ? { resume } : {}),
      ...(model ? { model } : {}),
    }
  }

  async ensure(): Promise<void> {
    if (this.closing) throw new Error('The Router session is closing')
    if (this.session) return
    this.opening ??= this.open().finally(() => { this.opening = undefined })
    await this.opening
  }

  async relay(id: string, text: string): Promise<void> {
    if (this.read.has(id) || this.unread.has(id)) return
    await this.ensure()
    this.transmit({ id, text, mode: 'steer' })
  }

  async notify(id: string, text: string): Promise<void> {
    if (this.read.has(id) || this.unread.has(id)) return
    await this.ensure()
    this.transmit({ id, text, mode: 'inject' })
  }

  async close(): Promise<void> {
    this.closing = true
    const session = this.session
    this.session = undefined
    await session?.close().catch(() => {})
  }

  private async open(): Promise<void> {
    const { deps } = this.options
    const record = deps.record.get()
    const version = deps.promptVersion()
    let resume = record?.sessionId ?? undefined
    const lead: RuntimeInput[] = []
    if (resume && record?.promptVersion) {
      const change = deps.promptChange(record.promptVersion)
      if (change.kind === 'fixed') {
        resume = undefined
        lead.push({ id: 'context:prompts:' + version, text: ROUTER_CONTEXT_NOTE, mode: 'inject' })
      } else if (change.kind === 'team') {
        lead.push({ id: 'notice:prompts:' + version, text: change.notice, mode: 'inject' })
      }
    }
    const pending = [...this.unread.values()]
    const session = await this.options.runtime.open(this.spec(resume))
    this.session = session
    deps.record.put({ sessionId: session.sessionId ?? resume ?? null, promptVersion: version })
    void this.loop(session)
    for (const input of lead) this.transmit(input)
    for (const input of pending) session.send(input)
    this.options.health?.set({ state: 'ready', detail: 'Router session open', at: this.stamp() })
  }

  private transmit(input: RuntimeInput): void {
    if (this.read.has(input.id) || this.unread.has(input.id)) return
    this.unread.set(input.id, input)
    try {
      this.session!.send(input)
    } catch (error) {
      this.unread.delete(input.id)
      this.session = undefined
      throw error
    }
  }

  private async loop(session: AgentSession): Promise<void> {
    for await (const event of session.events()) {
      if (event.type === 'session') {
        this.options.deps.record.put({
          sessionId: event.sessionId,
          promptVersion: this.options.deps.record.get()?.promptVersion ?? this.options.deps.promptVersion(),
        })
      } else if (event.type === 'inputsRead') {
        for (const id of event.ids) {
          this.unread.delete(id)
          this.read.add(id)
        }
        this.failures = 0
      } else if (event.type === 'turnEnded') {
        this.failures = 0
      } else if (event.type === 'closed') {
        break
      }
    }
    if (this.session === session) this.session = undefined
    if (this.closing) return
    this.failures += 1
    this.options.health?.set({
      state: this.failures >= REOPEN_LIMIT ? 'error' : 'ready',
      detail: 'The Router session closed; it resumes with the same session id',
      at: this.stamp(),
    })
    if (this.unread.size > 0 && this.failures < REOPEN_LIMIT) {
      void this.ensure().catch(error => this.options.health?.set({ state: 'error', detail: String(error), at: this.stamp() }))
    }
  }

  private stamp(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString()
  }
}
