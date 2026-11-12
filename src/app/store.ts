// Ported from dsh-superagent-prototype (MIT) src/app/store.ts
/**
 * SQLite persistence for domain aggregates, key-value state, and the channel outbox.
 * The Store holds a single-writer lock on the database file.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import {
  key,
  threadKey,
  type ChannelRef,
  type Decision,
  type OutboundMessage,
  type ReplyStatus,
  type Repositories,
  type Thread,
  type ThreadFact,
  type ThreadFacts,
  type Ticket,
  type Trigger,
  type TriggerDisposition,
} from '../core/index.ts'
import { KV, type Family, type Key } from './kv.ts'
import { storeReads } from './store-read.ts'

/** A Trigger's position on its thread timeline, ordered by timestamp and then `id` as tie-breaker. */
export interface TimelinePlace {
  at: string
  id: string
}
/**
 * Why a message was dropped: its conversation can never receive it (`channelGone`),
 * or its Source no longer listens to it (`channelIgnored`).
 */
export type DropReason = 'channelGone' | 'channelIgnored'
/**
 * Outbound message receipt tracked in the outbox from the moment it is queued
 * (`pending`, `sent`, or `dropped`); delivery attempt counts live on its `reply` effect.
 */
export interface Receipt extends OutboundMessage {
  status: ReplyStatus
  dropped?: { at: string; reason: DropReason }
}
/** A dropped outbound message receipt, with the timestamp and reason it was dropped. */
export type Dropped = Receipt & { dropped: { at: string; reason: DropReason } }
/** Why the AdmissionFilter refused a Trigger. */
export type RejectionReason = 'rejected-actor' | 'rejected-bot' | 'rejected-repo' | 'no-ticket'
export interface RejectedTrigger {
  triggerId: string
  repository: string
  actor: string
  at: string
  reason: RejectionReason
}
/** Generated columns and partial indexes for active working sets, computed by SQLite from the stored JSON rows. */
const SETS: Record<string, Record<string, string>> = {
  ticket: {
    open: "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)",
    // Only the latest assignment can be pending or running because the Engine closes one before adding the next.
    active: `INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0
      OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)`,
  },
  thread: {
    active:
      "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)",
    subscribed: "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)",
  },
  // Composite key (ticketId + thread) used to preserve per-conversation reply order.
  outbox: {
    dropped: "TEXT AS (value ->> '$.dropped.at')",
    pending: `TEXT AS (CASE WHEN value ->> '$.status' = 'pending'
    AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)`,
  },
}
/** Schema version this build reads and writes; a database stored at any other version is refused. */
export const SCHEMA_VERSION = 1
export const DATABASE_FILE = 'superagent-claude.db'
export const databasePath = (stateDir: string): string => join(stateDir, DATABASE_FILE)

// push_remote is unused but stays: databases written by 0.1.0 have this column.
function schemaSql(): string {
  const extra = (table: string): string =>
    Object.entries(SETS[table] ?? {})
      .map(([name, definition]) => `, ${name} ${definition}`)
      .join('')
  const sets = Object.entries(SETS).flatMap(([table, definitions]) =>
    Object.keys(definitions).map(
      name => `CREATE INDEX IF NOT EXISTS ${table}_${name} ON ${table}(${name}) WHERE ${name} IS NOT NULL;`,
    ),
  )
  return `
    CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL${extra('thread')});
    CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL${extra('ticket')});
    CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL${extra('outbox')});
    CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
      PRIMARY KEY (thread, id));
    CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL,
      since TEXT NOT NULL, PRIMARY KEY (kind, key));
    CREATE TABLE IF NOT EXISTS worker (ticket_id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, runtime TEXT NOT NULL, session_id TEXT, repository TEXT NOT NULL, cwd TEXT NOT NULL, branch TEXT NOT NULL, push_remote TEXT, turns INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, prompt_version TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS prompt_version (hash TEXT PRIMARY KEY, parts_json TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rejected_trigger (trigger_id TEXT PRIMARY KEY, repository TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, reason TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
    CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
    CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
    CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
    ${sets.join('\n    ')}
  `
}

function toRejected(row: Record<string, SQLInputValue>): RejectedTrigger {
  return {
    triggerId: String(row.trigger_id),
    repository: String(row.repository),
    actor: String(row.actor),
    at: String(row.at),
    reason: String(row.reason) as RejectionReason,
  }
}

/** The file next to the database that names the pid holding its single-writer lock. */
const ownerFile = (path: string): string => `${path}.owner`
/** The lock holder recorded in the owner file; `host` is absent for pid-only files. */
export interface LockOwner {
  pid: number
  host?: string
}
/**
 * The recorded lock owner, or undefined when the file is missing or names no positive pid.
 * An owner without a host is checked as a local process.
 */
export function lockOwner(path: string): LockOwner | undefined {
  let text: string
  try {
    text = readFileSync(ownerFile(path), 'utf8')
  } catch {
    return undefined
  }
  const [pidText, host] = text.trim().split(/\s+/)
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  return host ? { pid, host } : { pid }
}
/**
 * True when the lock on `path` names an owner pid that no longer runs on this host,
 * i.e. the owner was killed and left its lock behind.
 * A lock recorded on another host is never taken over at once.
 */
export function lockOwnerGone(path: string): boolean {
  const owner = lockOwner(path)
  if (!owner || owner.pid === process.pid) return false
  if (owner.host !== undefined && owner.host !== hostname()) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
/** A lock whose recorded owner pid no longer runs is taken over at once; otherwise the 30 s stale rule applies. */
function lockDatabase(path: string, report: (error: unknown) => void): () => void {
  const take = () =>
    lockSync(path, {
      realpath: false,
      stale: 30_000,
      onCompromised: error => {
        report(error)
      },
    })
  const locked = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOCKED'
  const refused = (cause: unknown): Error =>
    new Error(`Another superagent-claude process is writing ${path}`, { cause })
  let release: () => void
  try {
    release = take()
  } catch (error) {
    if (!locked(error)) throw error
    if (!lockOwnerGone(path)) throw refused(error)
    rmSync(`${path}.lock`, { recursive: true, force: true })
    try {
      release = take()
    } catch (again) {
      if (locked(again)) throw refused(again)
      throw again
    }
  }
  writeFileSync(ownerFile(path), `${process.pid} ${hostname()}`, { mode: 0o600 })
  return () => {
    try {
      rmSync(ownerFile(path), { force: true })
      release()
    } catch (error) {
      report(error)
    }
  }
}

/**
 * Opening takes a single-writer lock on the database file.
 * A database stored at any version other than `SCHEMA_VERSION` is refused.
 */
export class Store implements Repositories {
  readonly db: DatabaseSync
  /** Receives errors thrown by `afterCommit` callbacks and lock release without failing the committed transaction. */
  private readonly report: (error: unknown) => void
  private readonly unlock: () => void
  /**
   * Opens or creates the SQLite database at `path` under the single-writer lock.
   * Waits up to 5 s for a lock another connection holds (such as a reader during crash recovery).
   * @throws When another process holds the lock, when the stored schema is not `SCHEMA_VERSION`,
   * or when the database cannot be opened. In every case the lock is released and the SQLite handle
   * is closed so a later attempt can open it.
   */
  constructor(path: string, report: (error: unknown) => void = () => {}) {
    this.report = report
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.unlock = lockDatabase(path, report)
    try {
      this.db = new DatabaseSync(path)
    } catch (error) {
      this.unlock()
      throw error
    }
    this.read = storeReads(this.db)
    try {
      chmodSync(path, 0o600)
      this.db.exec(
        'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      )
      const version = this.get(KV.store.schema)
      if (version !== undefined && version !== SCHEMA_VERSION)
        throw new Error(`Unsupported database version ${version}: this build reads schema ${SCHEMA_VERSION} only`)
      this.atomic(() => {
        this.db.exec(schemaSql())
        if (version === undefined) this.set(KV.store.schema, SCHEMA_VERSION)
      })
    } catch (error) {
      this.db.close()
      this.unlock()
      throw error
    }
  }
  close(): void {
    this.db.close()
    this.unlock()
  }
  private values<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.db
      .prepare(sql)
      .all(...parameters)
      .map(row => JSON.parse(String(row.value)) as T)
  }
  /** Re-indexes which threads a Trigger belongs to, replacing any rows from an earlier save of the same Trigger. */
  private indexThreads(trigger: Trigger): void {
    this.db.prepare('DELETE FROM trigger_thread WHERE id=?').run(trigger.id)
    const insert = this.db.prepare('INSERT OR IGNORE INTO trigger_thread VALUES (?,?,?,?)')
    for (const ref of trigger.threads) insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0)
  }
  private depth = 0
  /** Post-commit callbacks, indexed by savepoint level; rolling back a level discards its callbacks. */
  private readonly committed: (() => void)[][] = []
  /**
   * Executes `operation` in a savepoint transaction (nested inside the current one if any);
   * a failure rolls back its changes.
   * Post-commit callbacks run only after the outermost transaction commits. Callback errors are reported
   * without failing the committed transaction.
   */
  atomic<T>(operation: () => T): T {
    const level = this.depth++
    const name = `orchestrator_atomic_${level}`
    this.committed[level] = []
    this.db.exec(`SAVEPOINT ${name}`)
    let value: T
    try {
      value = operation()
      this.db.exec(`RELEASE ${name}`)
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`)
      this.db.exec(`RELEASE ${name}`)
      throw error
    } finally {
      this.depth--
    }
    const actions = this.committed.splice(level)[0]!
    if (level) this.committed[level - 1]!.push(...actions)
    else
      for (const action of actions) {
        try {
          action()
        } catch (error) {
          this.report(error)
        }
      }
    return value
  }
  /**
   * Schedules `action` to run once the outermost transaction commits, or immediately if outside a transaction.
   * Callbacks queued inside a transaction that rolls back are discarded and never run.
   * Use `afterCommit` only for in-memory follow-ups that need not survive a restart;
   * use `Effects` for durable side effects.
   */
  afterCommit(action: () => void): void {
    if (this.depth) this.committed[this.depth - 1]!.push(action)
    else action()
  }
  get<V>(name: Key<V>): V | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(name)
    return row === undefined ? undefined : (JSON.parse(String(row.value)) as V)
  }
  set<V>(name: Key<V>, value: V): void {
    this.db
      .prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(name, JSON.stringify(value))
  }
  delete(name: string): void {
    this.db.prepare('DELETE FROM kv WHERE key=?').run(name)
  }
  /** Returns all KV keys belonging to `family` or starting with `prefix`. */
  keys<V>(family: Family<V, never>): Key<V>[]
  keys(prefix: string): string[]
  keys(family: string | { prefix: string }): string[] {
    const prefix = typeof family === 'string' ? family : family.prefix
    const pattern = `${prefix.replace(/[\\%_]/g, match => `\\${match}`)}%`
    return this.db
      .prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'")
      .all(pattern)
      .map(row => String(row.key))
  }

  readonly triggers = {
    get: (id: string): Trigger | undefined => {
      const row = this.db.prepare('SELECT value FROM trigger WHERE id=?').get(id)
      return row ? (JSON.parse(String(row.value)) as Trigger) : undefined
    },
    save: (trigger: Trigger): void =>
      this.atomic(() => {
        this.db
          .prepare(
            'INSERT INTO trigger VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at',
          )
          .run(trigger.id, JSON.stringify(trigger), trigger.at)
        this.indexThreads(trigger)
      }),
    disposition: (id: string): TriggerDisposition | undefined => {
      const row = this.db.prepare('SELECT value FROM disposition WHERE id=?').get(id)
      return row ? (JSON.parse(String(row.value)) as TriggerDisposition) : undefined
    },
    saveDisposition: (id: string, value: TriggerDisposition): void => {
      this.db
        .prepare('INSERT INTO disposition VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
        .run(id, JSON.stringify(value))
    },
  }
  readonly threads = {
    get: (keyValue: string): Thread | undefined => {
      const row = this.db.prepare('SELECT value FROM thread WHERE key=?').get(keyValue)
      return row ? (JSON.parse(String(row.value)) as Thread) : undefined
    },
    save: (thread: Thread): void => {
      this.db
        .prepare('INSERT INTO thread VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(thread.key, JSON.stringify(thread))
    },
    list: (): Thread[] =>
      this.db
        .prepare('SELECT value FROM thread ORDER BY rowid')
        .all()
        .map(row => JSON.parse(String(row.value)) as Thread),
    active: (): Thread[] => this.values('SELECT value FROM thread WHERE active = 1 ORDER BY rowid'),
    /**
     * Updates human-facing thread metadata. `null` in `facts` removes that fact by ID.
     * No-op if the thread does not exist.
     */
    describe: (
      keyValue: string,
      patch: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> },
    ): void => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const facts: ThreadFacts = { ...(thread.meta.facts as ThreadFacts | undefined) }
      for (const [id, fact] of Object.entries(patch.facts ?? {})) {
        if (fact) facts[id] = fact
        else delete facts[id]
      }
      const meta = {
        ...thread.meta,
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.url === undefined ? {} : { url: patch.url }),
        facts,
      }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    },
    /**
     * Atomically sets or removes (`undefined`) source-specific metadata keys after re-reading the thread.
     * No-op if the thread does not exist.
     */
    patchMeta: (keyValue: string, patch: Record<string, unknown>): void =>
      this.atomic(() => {
        const thread = this.threads.get(keyValue)
        if (!thread) return
        const meta = { ...thread.meta }
        for (const [name, value] of Object.entries(patch)) {
          if (value === undefined) delete meta[name]
          else meta[name] = value
        }
        if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
      }),
  }
  readonly tickets = {
    get: (id: string): Ticket | undefined => {
      const row = this.db.prepare('SELECT value FROM ticket WHERE id=?').get(id)
      return row ? (JSON.parse(String(row.value)) as Ticket) : undefined
    },
    save: (ticket: Ticket): void => {
      this.db
        .prepare('INSERT INTO ticket VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
        .run(ticket.id, JSON.stringify(ticket))
    },
    /** Newest first. */
    list: (): Ticket[] => this.values('SELECT value FROM ticket ORDER BY rowid DESC'),
    /** Newest first. */
    open: (): Ticket[] => this.values('SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC'),
    /** Newest first. */
    active: (): Ticket[] => this.values('SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC'),
  }
  readonly decisions = {
    get: (id: string): Decision | undefined => {
      const row = this.db.prepare('SELECT value FROM decision WHERE id=?').get(id)
      return row ? (JSON.parse(String(row.value)) as Decision) : undefined
    },
    save: (decision: Decision): void => {
      this.db
        .prepare(
          'INSERT INTO decision VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread',
        )
        .run(decision.id, decision.threadKey, JSON.stringify(decision))
    },
    byThread: (threadKeyValue: string): Decision[] =>
      this.db
        .prepare('SELECT value FROM decision WHERE thread=? ORDER BY rowid')
        .all(threadKeyValue)
        .map(row => JSON.parse(String(row.value)) as Decision),
  }
  /** Triggers the AdmissionFilter refused, one row per Trigger id (recording again is a no-op). */
  readonly rejected = {
    record: (entry: RejectedTrigger): boolean =>
      Number(
        this.db
          .prepare(
            'INSERT INTO rejected_trigger (trigger_id, repository, actor, at, reason) VALUES (?,?,?,?,?) ON CONFLICT(trigger_id) DO NOTHING',
          )
          .run(entry.triggerId, entry.repository, entry.actor, entry.at, entry.reason).changes,
      ) > 0,
    get: (triggerId: string): RejectedTrigger | undefined => {
      const row = this.db
        .prepare('SELECT trigger_id, repository, actor, at, reason FROM rejected_trigger WHERE trigger_id=?')
        .get(triggerId)
      return row === undefined ? undefined : toRejected(row)
    },
    /** Oldest first. */
    list: (): RejectedTrigger[] =>
      this.db
        .prepare('SELECT trigger_id, repository, actor, at, reason FROM rejected_trigger ORDER BY rowid')
        .all()
        .map(toRejected),
  }
  /** Read-only queries for management views, orchestrator tools, and source polling (see `storeReads`). */
  readonly read: ReturnType<typeof storeReads>

  /** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
  replyStatus(id: string): ReplyStatus | undefined {
    return this.receipts.get(id)?.status
  }
  /** Outbox message receipts for channel delivery; only `Outbox` writes to `receipts`. */
  readonly receipts = {
    get: (id: string): Receipt | undefined => this.values<Receipt>('SELECT value FROM outbox WHERE id = ?', id)[0],
    /** Pending message receipts, oldest first. */
    waiting: (): Receipt[] =>
      this.values("SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid"),
    /**
     * True if an earlier message for the same ticket and conversation is still pending,
     * with fewer than `failures` failed `reply` effect attempts.
     */
    behind: (id: string, failures: number): boolean =>
      !!this.db
        .prepare(
          `SELECT 1 FROM outbox earlier
      JOIN outbox message ON message.id = ? LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
      WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid AND IFNULL(effect.attempts, 0) < ? LIMIT 1`,
        )
        .get(id, failures),
    /**
     * Records a new pending message receipt; an already-recorded message ID keeps its original receipt.
     * @returns Whether the message ID was newly recorded.
     */
    add: (message: OutboundMessage): boolean => {
      const receipt: Receipt = { ...message, status: 'pending' }
      return (
        Number(
          this.db
            .prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
            .run(message.id, JSON.stringify(receipt)).changes,
        ) > 0
      )
    },
    /**
     * Marks a pending receipt as sent or dropped (with drop reason and timestamp).
     * Recreates the receipt if the message was withdrawn while being sent, so its ID cannot be queued again.
     */
    settle: (message: OutboundMessage, outcome: 'sent' | DropReason): void => {
      const settled =
        outcome === 'sent'
          ? { status: 'sent' }
          : { status: 'dropped', dropped: { at: new Date().toISOString(), reason: outcome } }
      const { id, channel, text, kind, ticketId } = message
      const updated = this.db
        .prepare("UPDATE outbox SET value = json_patch(value, ?) WHERE id = ? AND value ->> '$.status' = 'pending'")
        .run(JSON.stringify(settled), id)
      if (!Number(updated.changes))
        this.db
          .prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
          .run(id, JSON.stringify({ id, channel, text, kind, ...(ticketId ? { ticketId } : {}), ...settled }))
    },
    /**
     * Withdraws a pending message that has not yet been sent.
     * @returns Whether a pending message with `id` was waiting and removed.
     */
    withdraw: (id: string): boolean =>
      Number(this.db.prepare("DELETE FROM outbox WHERE id = ? AND value ->> '$.status' = 'pending'").run(id).changes) >
      0,
  }
}
export { key, threadKey }
export type { ChannelRef }
