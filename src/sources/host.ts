// Ported from dsh-superagent-prototype (MIT) src/sources/host.ts
/** Host and context interfaces connecting Source plugins to the application, and the builder of one kind's context. Changes from the reference: the deployment, command runner, setup readiness and setup problem members are removed; a kind reports health under its own entry or `<kind>:<entry>` instead of a declared list; `log` is added and `receive` is synchronous; the context builder moves here from the app layer as `sourceContext`; `SourceService` (a running Source's start and stop) is added; the health codes of removed kinds are dropped. */
import type {
  EngineForSources,
  OutboundMessage,
  Outbox,
  ReceiveResult,
  Thread,
  ThreadFact,
  ThreadRef,
  Ticket,
  Trigger,
} from '../core/index.ts'
import type { Family, Key } from '../app/kv.ts'
import type { Store } from '../app/store.ts'
import type { Health } from '../infra/health.ts'
import { fill } from '../infra/text.ts'
import type { SourceRegistry } from './registry.ts'

/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
export const HEALTH_TEXT = {
  sourceOff: 'Off',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...(Object.keys(values).length ? { values } : {}) }
}

export type LogLevel = 'info' | 'warn' | 'error'
export interface LogRecord {
  level: LogLevel
  at: string
  event: string
  ticketId?: string
  assignmentId?: string
  [field: string]: unknown
}
export type LogSink = (record: LogRecord) => void

export interface SourceHost {
  readonly sources: SourceRegistry
  /** Returns the context for one Source kind; its `report` writes only that kind's health entries. */
  context(kind: string): SourceContext
}

/** A running Source: started by the Runtime after recovery with its lifetime signal; `stop` resolves once polling ended, and the Runtime calls it only after `start` resolved. */
export interface SourceService {
  readonly kind: string
  start(host: SourceHost, signal: AbortSignal): Promise<void>
  stop(): Promise<void>
}

/** Display label, URL, and facts (`null` removes a fact) that a Source publishes on a Thread. */
export interface ThreadDescription {
  label?: string
  url?: string
  facts?: Record<string, ThreadFact | null>
}
/** Application capabilities exposed to a Source kind for reading state, ingesting triggers, managing threads/tickets, and reporting health. */
export interface SourceContext {
  /** Returns a Source's configuration while enabled, or undefined while disabled or uninstalled. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** Ingests a trigger into the Engine and schedules the next evaluation pass. */
  receive(trigger: Trigger): ReceiveResult
  atomic<T>(work: () => T): T
  /** Source-scoped KV records (such as read cursors); setting `undefined` removes an entry. */
  state: {
    get<V>(key: Key<V>): V | undefined
    set<V>(key: Key<V>, value: V | undefined): void
    keys<V>(family: Family<V, never>): Key<V>[]
  }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    /** Sets or removes (`undefined`) keys in a Thread's `meta` after rereading it; a missing Thread is left alone. */
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** Open tickets, newest first. */
    open(): Ticket[]
    /** Binds an open ticket to follow a Source Thread (`own` when opened by the ticket) so the Thread's close, not a ready report, ends the ticket. */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    /** Reports that a followed Thread closed at `at`; each open ticket following it ends once no `own` Thread remains open and no resumed work is still running. */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: {
    get(id: string): Trigger | undefined
    /** The newest Trigger on a Thread. */ latest(thread: string): Trigger | undefined
  }
  notify(message: OutboundMessage): void
  /** Reports the state of this kind's health entry, or of its `<kind>:<entry>` entry. */
  report(health: Health, entry?: string): void
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void
}

export interface SourceContextDeps {
  readonly store: Pick<
    Store,
    'atomic' | 'get' | 'set' | 'delete' | 'keys' | 'threads' | 'tickets' | 'triggers' | 'read'
  >
  readonly outbox: Pick<Outbox, 'send'>
  readonly engine: Pick<EngineForSources, 'bindThread' | 'threadClosed'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'reporter'>
  readonly log: LogSink
  now(): number
  receive(trigger: Trigger): ReceiveResult
}

/**
 * Builds the context for one Source kind. Health reports go to the entries of the registration current when the context
 * is built, becoming no-ops once that registration ends.
 */
export function sourceContext(deps: SourceContextDeps, kind: string): SourceContext {
  const { store } = deps
  const report = deps.sources.reporter(kind)
  return {
    config: <C extends Record<string, unknown>>(id: string) => {
      const instance = deps.sources.instance<C>(id)
      return instance?.enabled ? instance.config : undefined
    },
    receive: trigger => deps.receive(trigger),
    atomic: work => store.atomic(work),
    state: {
      get: name => store.get(name),
      set: (name, value) => {
        if (value === undefined) store.delete(name)
        else store.set(name, value)
      },
      keys: prefix => store.keys(prefix),
    },
    threads: {
      get: key => store.threads.get(key),
      subscribed: source => store.read.subscribedThreads(source),
      describe: (key, description) => store.threads.describe(key, description),
      patch: (key, meta) => {
        store.threads.patchMeta(key, meta)
      },
    },
    tickets: {
      get: id => store.tickets.get(id),
      open: () => store.tickets.open(),
      bindThread: (id, thread, own) => {
        deps.engine.bindThread(id, thread, own)
      },
      threadClosed: (thread, outcome, at) => {
        deps.engine.threadClosed(thread, outcome, at)
      },
    },
    triggers: { get: id => store.triggers.get(id), latest: thread => store.read.threadTriggers(thread, 1)[0] },
    notify: message => {
      deps.outbox.send(message)
    },
    report: (value, entry) => {
      report(value, entry)
    },
    log: (level, event, fields = {}) => {
      deps.log({ ...fields, level, at: new Date(deps.now()).toISOString(), event, source: kind })
    },
  }
}
