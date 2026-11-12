/**
 * Scripted stand-in for the SDK query: records the user messages the adapter sends and lets a test stream back the
 * messages the SDK would emit.
 */
import type {
  HookInput,
  Options,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn, QueryHandle } from '../../src/runtimes/claude/runtime.ts'

export class StubQuery implements QueryHandle {
  readonly options: Options
  readonly received: SDKUserMessage[] = []
  receipt: string[] = []
  interrupts = 0
  closed = false
  private readonly messages: SDKMessage[] = []
  private wake?: () => void
  private done = false
  private failure?: Error

  constructor(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) {
    this.options = params.options
    void (async () => {
      for await (const message of params.prompt) this.received.push(message)
    })()
  }

  push(message: object): void {
    this.messages.push(message as SDKMessage)
    this.wake?.()
  }

  fail(error: Error): void {
    this.failure = error
    this.wake?.()
  }

  end(): void {
    this.done = true
    this.wake?.()
  }

  async interrupt(): Promise<SDKControlInterruptResponse> {
    this.interrupts += 1
    return { still_queued: this.receipt }
  }

  close(): void {
    this.closed = true
    this.end()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    for (;;) {
      while (this.messages.length > 0) yield this.messages.shift()!
      if (this.failure) throw this.failure
      if (this.done) return
      await new Promise<void>(resolve => {
        this.wake = () => resolve()
      })
      this.wake = undefined
    }
  }

  async hook(event: 'UserPromptSubmit' | 'PostToolBatch' | 'PreToolUse', input: object): Promise<unknown> {
    const matcher = this.options.hooks?.[event]?.[0]
    return matcher?.hooks[0]?.(input as HookInput, undefined, { signal: new AbortController().signal })
  }
}

export function stubSdk(): { query: QueryFn; queries: StubQuery[] } {
  const queries: StubQuery[] = []
  return {
    queries,
    query: params => {
      const stub = new StubQuery(params)
      queries.push(stub)
      return stub
    },
  }
}

export function result(uuid: string | undefined, total: number, subtype = 'success'): object {
  return {
    type: 'result',
    subtype,
    user_message_uuid: uuid,
    total_cost_usd: total,
    num_turns: 1,
    is_error: subtype !== 'success',
  }
}
