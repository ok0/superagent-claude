/** A scripted AgentRuntime for tests and demos: each turn runs the reaction its script returns, following the input-mode semantics of docs/runtime-contract.md deterministically (no real time or network; delays use injected timers). */
import type {
  AgentRuntime,
  AgentSession,
  RuntimeEvent,
  RuntimeInput,
  RuntimeProbe,
  SessionSpec,
  TurnOutcome,
} from '../../executor/contract.ts'

export interface FakeToolCall {
  name: string
  args: unknown
}
export interface FakeReaction {
  hold?: Promise<unknown>
  delayMs?: number
  tools?: FakeToolCall[]
  repeatReads?: boolean
  turnEnded?: { outcome?: TurnOutcome; turns?: number; costUsd?: number; background?: number }
  error?: { message: string; retryable: boolean }
}
export interface FakeTurn {
  spec: SessionSpec
  session: FakeSession
  index: number
  inputs: RuntimeInput[]
}
export type FakeScript = (turn: FakeTurn) => FakeReaction | undefined
export interface FakeTimers {
  setTimeout(run: () => void, ms: number): unknown
}
export interface FakeOptions {
  timers?: FakeTimers
  probe?: RuntimeProbe
}

function until(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
    promise.then(
      () => resolve(),
      () => resolve(),
    )
  })
}

export class FakeSession implements AgentSession {
  readonly sessionId: string
  readonly spec: SessionSpec
  readonly sent: RuntimeInput[] = []
  readonly turns: { inputs: string[] }[] = []
  readonly toolCalls: { name: string; args: unknown; result?: unknown; error?: string }[] = []
  readonly log: RuntimeEvent[] = []
  interrupts = 0
  closed = false
  private busy = false
  private readonly pendingSteer: RuntimeInput[] = []
  private readonly followups: RuntimeInput[] = []
  private readonly injects: RuntimeInput[] = []
  private readonly queue: RuntimeEvent[] = []
  private wake?: () => void
  private ended = false
  private abort?: AbortController
  private reaction?: FakeReaction
  private readonly script: FakeScript
  private readonly timers: FakeTimers

  constructor(spec: SessionSpec, sessionId: string, script: FakeScript, timers: FakeTimers) {
    this.spec = spec
    this.sessionId = sessionId
    this.script = script
    this.timers = timers
    this.emit({ type: 'session', sessionId })
  }

  async *events(): AsyncGenerator<RuntimeEvent> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!
      if (this.ended) return
      await new Promise<void>(resolve => {
        this.wake = () => resolve()
      })
      this.wake = undefined
    }
  }

  send(input: RuntimeInput): void {
    if (this.closed) throw new Error('The session is closed')
    this.sent.push(input)
    if (input.mode === 'inject') this.injects.push(input)
    else if (this.busy) (input.mode === 'steer' ? this.pendingSteer : this.followups).push(input)
    else this.startTurn([...this.injects.splice(0), input])
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    this.interrupts += 1
    const queued = [...this.pendingSteer.splice(0), ...this.followups.splice(0), ...this.injects.splice(0)]
    this.abort?.abort()
    if (this.busy) {
      const end = this.reaction?.turnEnded ?? {}
      this.emit({
        type: 'turnEnded',
        outcome: end.outcome ?? 'success',
        turns: end.turns ?? 1,
        costUsd: end.costUsd ?? 0,
        background: 0,
        discarded: true,
      })
    }
    this.busy = false
    return { stillQueued: queued.map(input => input.id) }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.abort?.abort()
    this.emit({ type: 'closed' })
    this.ended = true
    this.wake?.()
  }

  private emit(event: RuntimeEvent): void {
    if (this.ended) return
    this.log.push(event)
    this.queue.push(event)
    this.wake?.()
  }

  private read(turn: { inputs: string[] }, inputs: RuntimeInput[], repeat: boolean): void {
    const ids = inputs.map(input => input.id)
    turn.inputs.push(...ids)
    this.emit({ type: 'inputsRead', ids: [...ids] })
    if (repeat) this.emit({ type: 'inputsRead', ids: [...ids] })
  }

  private startTurn(inputs: RuntimeInput[]): void {
    this.busy = true
    const index = this.turns.length
    this.turns.push({ inputs: [] })
    const reaction = this.script({ spec: this.spec, session: this, index, inputs }) ?? {}
    this.reaction = reaction
    this.read(this.turns[index]!, inputs, reaction.repeatReads === true)
    this.abort = new AbortController()
    void this.run(reaction, this.abort.signal, this.turns[index]!)
  }

  private pause(ms: number, signal: AbortSignal): Promise<void> {
    return until(
      new Promise<void>(resolve => {
        this.timers.setTimeout(() => resolve(), ms)
      }),
      signal,
    )
  }

  private async run(reaction: FakeReaction, signal: AbortSignal, turn: { inputs: string[] }): Promise<void> {
    await Promise.resolve()
    if (reaction.hold) await until(reaction.hold, signal)
    if (signal.aborted) return
    const delay = reaction.delayMs ?? 0
    for (const call of reaction.tools ?? []) {
      if (delay > 0) await this.pause(delay, signal)
      if (signal.aborted) return
      const record: { name: string; args: unknown; result?: unknown; error?: string } = {
        name: call.name,
        args: call.args,
      }
      const tool = this.spec.tools.find(candidate => candidate.name === call.name)
      if (!tool) record.error = 'unknown tool'
      else {
        try {
          record.result = await tool.execute(tool.schema.parse(call.args), signal)
        } catch (e) {
          record.error = String(e)
        }
      }
      this.toolCalls.push(record)
      if (signal.aborted) return
      if (this.pendingSteer.length > 0)
        this.read(turn, [...this.injects.splice(0), ...this.pendingSteer.splice(0)], reaction.repeatReads === true)
    }
    if (delay > 0) await this.pause(delay, signal)
    if (signal.aborted) return
    if (reaction.error) {
      this.emit({ type: 'error', message: reaction.error.message, retryable: reaction.error.retryable })
      this.busy = false
      if (reaction.error.retryable) this.next()
      else await this.close()
      return
    }
    const end = reaction.turnEnded ?? {}
    this.emit({
      type: 'turnEnded',
      outcome: end.outcome ?? 'success',
      turns: end.turns ?? 1,
      costUsd: end.costUsd ?? 0,
      background: end.background ?? 0,
    })
    this.busy = false
    this.next()
  }

  private next(): void {
    if (this.closed) return
    if (this.pendingSteer.length > 0) this.startTurn([...this.injects.splice(0), ...this.pendingSteer.splice(0)])
    else if (this.followups.length > 0) this.startTurn([...this.injects.splice(0), this.followups.shift()!])
  }
}

export class FakeRuntime implements AgentRuntime {
  readonly id = 'fake'
  readonly opened: SessionSpec[] = []
  readonly sessions: FakeSession[] = []
  maxActive = 0
  private n = 0
  private readonly script: FakeScript
  private readonly timers: FakeTimers
  private readonly probeResult: RuntimeProbe

  get active(): number {
    return this.sessions.filter(session => !session.closed).length
  }

  constructor(script: FakeScript, options: FakeOptions = {}) {
    this.script = script
    this.timers = options.timers ?? { setTimeout: (run, ms) => setTimeout(run, ms) }
    this.probeResult = options.probe ?? { sandbox: false, version: 'fake' }
  }

  async open(spec: SessionSpec): Promise<FakeSession> {
    this.n += 1
    const session = new FakeSession(spec, spec.resume ?? `fake-${this.n}`, this.script, this.timers)
    this.opened.push(spec)
    this.sessions.push(session)
    this.maxActive = Math.max(this.maxActive, this.active)
    return session
  }

  async probe(): Promise<RuntimeProbe> {
    return this.probeResult
  }
}
