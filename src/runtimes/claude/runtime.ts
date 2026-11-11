/**
 * Claude runtime adapter: one SDK query per session fed by a message stream. steer is sent into the running turn with priority next;
 * followup is held until the running turn's result; inject is merged into the next input sent (never sent alone, the SDK shouldQuery
 * flag is unused). Message uuids are adapter UUIDs mapped to input ids. The permission mode is fixed by options.ts.
 * A result suppressed by interrupt does not end the newer turn: busy and held followups wait for that turn's own result.
 */
import { query as sdkQuery, type Options, type SDKMessage, type SDKUserMessage, type SDKControlInterruptResponse } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { AgentRuntime, AgentSession, RuntimeEvent, RuntimeInput, RuntimeProbe, SessionSpec } from '../../executor/contract.ts'
import { sdkOptions, type AuthMode, type OptionsContext } from './options.ts'
import { EventMapper, subagentMessage } from './events.ts'
import { mcpServer } from './mcp.ts'
import { ChildRegistry, reapChildren, trackedSpawn } from './children.ts'

export const CLAUDE_SDK_VERSION = '0.3.321'
export const INJECT_SEPARATOR = '\n\n---\n\n'

export interface QueryHandle extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<SDKControlInterruptResponse | undefined>
  close(): void
}

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryHandle

export interface ToolDenial { key: string; tool: string; reason: string; agentId?: string }

export interface ClaudeRuntimeOptions {
  mode: AuthMode
  configDir: string
  env?: Readonly<Record<string, string | undefined>>
  sandbox?: boolean
  query?: QueryFn
  sandboxAvailable?: () => boolean
  stderr?: (text: string) => void
  trustRepoConfig?: boolean
  /** security.weakerNestedSandbox: Linux only, skip the fresh /proc mount inside the sandbox (ADR-27). */
  weakerNestedSandbox?: boolean
  /** security.allowUnsandboxed: open sessions without the sandbox when the probe finds none. */
  allowUnsandboxed?: boolean
  onDeny?: (denial: ToolDenial) => void
  /** <stateDir>/children.json: track SDK child pids there (ADR-32). */
  children?: string
}

export function bwrapProbeArgs(weakerNested: boolean): string[] {
  return ['--ro-bind', '/', '/', '--dev', '/dev', ...(weakerNested ? ['--tmpfs', '/proc'] : ['--proc', '/proc']), '--unshare-all', '--die-with-parent', 'true']
}

/** Linux: bwrap and socat on PATH and one bwrap smoke run with the same /proc choice the SDK makes (fresh /proc, or a tmpfs /proc with weakerNested, the mask the SDK also adds). */
export function sandboxAvailable(
  platform: NodeJS.Platform = process.platform,
  weakerNested = false,
  run: (cmd: string, args: string[]) => number | null = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 10_000 }).status,
): boolean {
  if (platform === 'darwin') return existsSync('/usr/bin/sandbox-exec')
  if (platform === 'linux') return run('sh', ['-c', 'command -v bwrap && command -v socat']) === 0 && run('bwrap', bwrapProbeArgs(weakerNested)) === 0
  return false
}

class MessageStream implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = []
  private wake?: () => void
  private done = false

  push(message: SDKUserMessage): void {
    if (this.done) return
    this.items.push(message)
    this.wake?.()
  }

  end(): void {
    this.done = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!
      if (this.done) return
      await new Promise<void>(resolve => { this.wake = () => resolve() })
      this.wake = undefined
    }
  }
}

interface SessionConfig {
  mode: AuthMode
  configDir: string
  env: Readonly<Record<string, string | undefined>>
  sandbox: boolean
  stderr?: (text: string) => void
  trustRepoConfig: boolean
  weakerNestedSandbox: boolean
  onDeny?: (denial: ToolDenial) => void
  spawn?: OptionsContext['spawn']
}

export class ClaudeSession implements AgentSession {
  private readonly id: string
  private readonly mapper: EventMapper
  private readonly stream = new MessageStream()
  private readonly abort = new AbortController()
  private readonly q: QueryHandle
  private readonly pumping: Promise<void>
  private readonly queue: RuntimeEvent[] = []
  private wakeEvents?: () => void
  private busy = false
  private suppressed = 0
  private readonly followups: RuntimeInput[] = []
  private readonly injects: RuntimeInput[] = []
  private readonly carried = new Map<string, string[]>()
  private closing = false
  private ended = false
  private closedEmitted = false

  constructor(spec: SessionSpec, config: SessionConfig, queryFn: QueryFn) {
    this.id = spec.resume ?? randomUUID()
    this.mapper = new EventMapper(this.id)
    const options = sdkOptions(spec, {
      mode: config.mode,
      env: config.env,
      configDir: config.configDir,
      sandbox: config.sandbox,
      weakerNestedSandbox: config.weakerNestedSandbox,
      sessionId: spec.resume ? undefined : this.id,
      mcp: spec.tools.length ? mcpServer(spec.tools, this.abort.signal) : undefined,
      onRead: () => this.emitAll(this.mapper.read()),
      abortController: this.abort,
      stderr: config.stderr,
      trustRepoConfig: config.trustRepoConfig,
      onDeny: config.onDeny ? (tool, reason, agentId?: string) => config.onDeny!({ key: spec.key, tool, reason, ...(agentId !== undefined ? { agentId } : {}) }) : undefined,
      spawn: config.spawn,
    })
    this.q = queryFn({ prompt: this.stream, options })
    this.emit({ type: 'session', sessionId: this.id })
    this.pumping = this.pump()
  }

  get sessionId(): string {
    return this.id
  }

  async *events(): AsyncGenerator<RuntimeEvent> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!
      if (this.ended) return
      await new Promise<void>(resolve => { this.wakeEvents = () => resolve() })
      this.wakeEvents = undefined
    }
  }

  send(input: RuntimeInput): void {
    if (this.closing || this.ended) throw new Error('The session is closed')
    if (input.mode === 'inject') this.injects.push(input)
    else if (input.mode === 'steer') this.transmit(input, 'next')
    else if (this.busy) this.followups.push(input)
    else this.transmit(input)
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    const pending = [...this.followups.splice(0), ...this.injects.splice(0)].map(input => input.id)
    if (!this.busy) return { stillQueued: pending }
    const receipt = await this.q.interrupt().catch(() => undefined)
    this.mapper.skipNextResult()
    this.suppressed += 1
    this.busy = false
    const sdk = this.mapper.queued(receipt?.still_queued ?? [])
    return { stillQueued: [...new Set([...sdk, ...pending])] }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.stream.end()
    try {
      this.q.close()
    } catch {}
    this.abort.abort()
    let timer: NodeJS.Timeout | undefined
    await Promise.race([this.pumping, new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000) })])
    clearTimeout(timer)
    this.finish()
  }

  private transmit(input: RuntimeInput, priority?: 'next'): void {
    const carriedInputs = this.injects.splice(0)
    const text = [...carriedInputs.map(carried => carried.text), input.text].join(INJECT_SEPARATOR)
    const ids = [...carriedInputs.map(carried => carried.id), input.id]
    const uuid = randomUUID()
    this.carried.set(uuid, ids)
    this.mapper.sent(uuid, ids)
    this.stream.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.id,
      uuid,
      ...(priority ? { priority } : {}),
    } as SDKUserMessage)
    this.busy = true
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) {
        const events = this.mapper.message(msg)
        this.emitAll(events)
        if (msg.type === 'result' && !subagentMessage(msg)) {
          if (this.suppressed > 0) {
            this.suppressed -= 1
            continue
          }
          this.busy = false
          if (events.some(event => event.type === 'error' && !event.retryable)) {
            void this.close()
            return
          }
          const next = this.followups.shift()
          if (next) this.transmit(next)
        }
      }
    } catch (error) {
      if (!this.closing) this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error), retryable: false })
    } finally {
      this.finish()
    }
  }

  private finish(): void {
    if (this.closedEmitted) return
    this.closedEmitted = true
    this.emit({ type: 'closed' })
    this.ended = true
    this.stream.end()
    this.wakeEvents?.()
  }

  private emit(event: RuntimeEvent): void {
    if (this.ended) return
    this.queue.push(event)
    this.wakeEvents?.()
  }

  private emitAll(events: RuntimeEvent[]): void {
    for (const event of events) this.emit(event)
  }
}

export class ClaudeRuntime implements AgentRuntime {
  readonly id = 'claude'
  private readonly options: ClaudeRuntimeOptions
  private registry?: ChildRegistry
  private usable?: boolean

  constructor(options: ClaudeRuntimeOptions) {
    this.options = options
    if (options.children) this.registry = new ChildRegistry(options.children)
  }

  private sandboxUsable(): boolean {
    return this.usable ??= (this.options.sandboxAvailable ?? (() => sandboxAvailable(process.platform, this.options.weakerNestedSandbox ?? false)))()
  }

  async open(spec: SessionSpec): Promise<ClaudeSession> {
    return new ClaudeSession(spec, {
      mode: this.options.mode,
      configDir: this.options.configDir,
      env: this.options.env ?? process.env,
      sandbox: (this.options.sandbox ?? true) && (!this.options.allowUnsandboxed || this.sandboxUsable()),
      weakerNestedSandbox: this.options.weakerNestedSandbox ?? false,
      stderr: this.options.stderr,
      trustRepoConfig: this.options.trustRepoConfig ?? false,
      onDeny: this.options.onDeny,
      spawn: this.registry ? trackedSpawn(this.registry, this.options.stderr) : undefined,
    }, this.options.query ?? sdkQuery)
  }

  async reap(): Promise<number[]> {
    return this.registry ? reapChildren(this.registry) : []
  }

  async probe(): Promise<RuntimeProbe> {
    return {
      sandbox: (this.options.sandbox ?? true) && this.sandboxUsable(),
      version: CLAUDE_SDK_VERSION,
    }
  }
}
