import {
  latestAssignment,
  latestReport,
  runningAssignment,
  ticketStage,
  type Assignment,
  type Thread,
  type Ticket,
  type Trigger,
} from '../core/index.ts'
import type { Health, HealthSnapshot } from '../infra/health.ts'
import { KV, record } from './kv.ts'
import type { StoreReader } from './store-read.ts'

/** KV family the repository Source writes per repository: { accessible, push, at, error? }. */
export const REPOSITORY_ACCESS_PREFIX = 'repo-access:'
export const STALE_SNAPSHOT_MS = 60_000
export interface RepositoryAccessView {
  repository: string
  accessible: boolean
  push: boolean
  at: string
  error?: string
}
export interface StatusView {
  daemon: boolean
  snapshot?: { at: string; ageMs: number }
  running: { ticketId: string; title: string; startedAt: string }[]
  idle: { ticketId: string; title: string; idleAt: string }[]
  waiting: { ticketId: string; title: string; since: string }[]
  errors: { source: string; detail: string; at?: string }[]
  repositories: RepositoryAccessView[]
  /** undefined when there is no snapshot; { applicable: false } without a recorded consent. */
  consent?: { applicable: false; mode: string } | { applicable: true; mode: string; at: string; allowedHash: string }
}

type RepositoryAccessValue = Omit<RepositoryAccessView, 'repository'>

function rows<T>(reader: StoreReader, sql: string, ...params: (string | number)[]): T[] {
  return reader.db
    .prepare(sql)
    .all(...params)
    .map(row => JSON.parse(String(row.value)) as T)
}

function trigger(reader: StoreReader, id: string | undefined): Trigger | undefined {
  if (id === undefined) return undefined
  const row = reader.db.prepare('SELECT value FROM trigger WHERE id = ?').get(id)
  return row ? (JSON.parse(String(row.value)) as Trigger) : undefined
}

function thread(reader: StoreReader, key: string): Thread | undefined {
  const row = reader.db.prepare('SELECT value FROM thread WHERE key = ?').get(key)
  return row ? (JSON.parse(String(row.value)) as Thread) : undefined
}

/**
 * When a running Assignment's Session went idle: its last turn ended (idleAt), nothing waits to be delivered,
 * and no message delivered to it is unread or was read after that.
 */
function idleSince(ticket: Ticket, assignment: Assignment): string | undefined {
  const at = assignment.idleAt
  if (!at || ticket.undelivered.length > 0) return undefined
  const busy = ticket.inputs.some(
    input =>
      input.kind === 'trigger' &&
      ((input.readAt === null && (input.deliveredTo ?? assignment.id) === assignment.id) ||
        (typeof input.readAt === 'string' && input.readAt > at)),
  )
  return busy ? undefined : at
}

function cut(text: string): string {
  return text.slice(0, 300)
}

export function statusView(reader: StoreReader, options: { daemon: boolean; now: number }): StatusView {
  const open = rows<Ticket>(reader, 'SELECT value FROM ticket WHERE open = 1 ORDER BY rowid')
  const running: StatusView['running'] = [],
    idle: StatusView['idle'] = []
  for (const t of open) {
    const a = runningAssignment(t)
    if (!a) continue
    const since = idleSince(t, a)
    if (since) idle.push({ ticketId: t.id, title: t.title, idleAt: since })
    else running.push({ ticketId: t.id, title: t.title, startedAt: a.startedAt ?? a.createdAt })
  }
  const waiting = open.flatMap(t => {
    const s = ticketStage(t)
    return s.stage === 'working' && s.action === 'queued'
      ? [{ ticketId: t.id, title: t.title, since: latestAssignment(t)?.createdAt ?? t.createdAt }]
      : []
  })
  const snap = reader.get<HealthSnapshot>(KV.health.snapshot)
  const snapshot = snap && { at: snap.at, ageMs: options.now - Date.parse(snap.at) }
  const healthErrors = Object.entries(snap?.entries ?? {})
    .filter((entry): entry is [string, Health] => entry[1].state === 'error')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, h]) => ({ source: 'health ' + name, detail: h.detail, at: h.at }))
  const effectErrors = reader.db
    .prepare('SELECT kind, key, attempts, error, since FROM effect WHERE attempts > 0 ORDER BY seq DESC LIMIT 10')
    .all()
    .map(row => ({
      source: `effect ${String(row.kind)} ${String(row.key)}`,
      detail: `${String(row.attempts)} failed attempts; last: ${String(row.error)}`,
    }))
  const repositories = reader.keys(REPOSITORY_ACCESS_PREFIX).flatMap(key => {
    const value = reader.get(record<RepositoryAccessValue>(key))
    return value === undefined ? [] : [{ repository: key.slice(REPOSITORY_ACCESS_PREFIX.length), ...value }]
  })
  let consent: StatusView['consent']
  if (snap) {
    const authValues = snap.entries.auth?.values ?? {}
    const mode = authValues.mode ?? 'unknown'
    consent =
      authValues.consentAt && authValues.allowedHash
        ? { applicable: true, mode, at: authValues.consentAt, allowedHash: authValues.allowedHash }
        : { applicable: false, mode }
  }
  const view: StatusView = {
    daemon: options.daemon,
    ...(snapshot ? { snapshot } : {}),
    running,
    idle,
    waiting,
    errors: [...healthErrors, ...effectErrors],
    repositories,
    ...(consent ? { consent } : {}),
  }
  return view
}

export function formatStatus(view: StatusView): string {
  const lines: string[] = []
  lines.push(`Daemon: ${view.daemon ? 'running' : 'not running'}`)
  if (view.snapshot) {
    const stale = view.daemon && view.snapshot.ageMs > STALE_SNAPSHOT_MS ? '; stale' : ''
    lines.push(`Health snapshot: ${view.snapshot.at} (${Math.round(view.snapshot.ageMs / 1000)}s ago)${stale}`)
  } else {
    lines.push('Health snapshot: none yet')
  }
  if (view.running.length) {
    lines.push(`Running assignments (${view.running.length}):`)
    for (const r of view.running) lines.push(`  ${r.ticketId}  ${r.title}  started ${r.startedAt}`)
  } else {
    lines.push('Running assignments: none')
  }
  if (view.idle.length) {
    lines.push(`Idle sessions (${view.idle.length}):`)
    for (const i of view.idle) lines.push(`  ${i.ticketId}  ${i.title}  idle since ${i.idleAt}`)
  } else {
    lines.push('Idle sessions: none')
  }
  if (view.waiting.length) {
    lines.push(`Waiting tickets (${view.waiting.length}):`)
    for (const w of view.waiting) lines.push(`  ${w.ticketId}  ${w.title}  queued since ${w.since}`)
  } else {
    lines.push('Waiting tickets: none')
  }
  if (view.errors.length) {
    lines.push(`Recent errors (${view.errors.length}):`)
    for (const e of view.errors) lines.push(`  ${e.source}: ${cut(e.detail)}${e.at ? ` (${e.at})` : ''}`)
  } else {
    lines.push('Recent errors: none')
  }
  if (view.repositories.length) {
    lines.push(`Repository access (${view.repositories.length}):`)
    for (const r of view.repositories) {
      lines.push(
        r.accessible
          ? `  ${r.repository}  accessible, push ${r.push ? 'allowed' : 'not allowed'} (checked ${r.at})`
          : `  ${r.repository}  not accessible: ${cut(r.error ?? 'unknown error')} (checked ${r.at})`,
      )
    }
  } else {
    lines.push('Repository access: not checked yet')
  }
  const consent = view.consent
  if (!consent) lines.push('Subscription consent: unknown (no health snapshot yet)')
  else if (consent.applicable)
    lines.push(`Subscription consent: given at ${consent.at} (allowed list hash ${consent.allowedHash})`)
  else lines.push(`Subscription consent: not applicable (auth.mode ${consent.mode})`)
  return lines.join('\n') + '\n'
}

export interface NeedItem {
  ticketId: string
  title: string
  stage: string
  label?: 'Question' | 'Report' | 'Delivery error' | 'Environment blocked'
  text?: string
  links: string[]
  pulls: string[]
}
export interface NeedsView {
  person: NeedItem[]
  others: NeedItem[]
}

export function needsView(
  reader: StoreReader,
  options: { all: boolean; endedWithinMs: number; now: number },
): NeedsView {
  const open = rows<Ticket>(reader, 'SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC')
  const stageLabel = (t: Ticket): string => {
    const s = ticketStage(t)
    if (s.stage === 'person') return `person:${s.action}`
    if (s.stage === 'working') return s.action ? `working:${s.action}` : 'working'
    if (s.stage === 'ended') return `ended:${String(t.ended?.outcome)}`
    return 'idle'
  }
  const item = (t: Ticket): NeedItem => {
    const s = ticketStage(t)
    const urls = [trigger(reader, t.attention?.triggerId)?.url, trigger(reader, t.origin.triggerId)?.url]
    const links = [...new Set(urls.filter((url): url is string => typeof url === 'string' && url !== ''))]
    const pulls = (t.follows ?? [])
      .filter(f => f.own)
      .map(f => {
        const url = thread(reader, f.thread)?.meta?.url
        return typeof url === 'string' ? url : f.thread
      })
    let label: NeedItem['label']
    let text: string | undefined
    const latest = latestAssignment(t)
    if (s.stage === 'person') {
      if (s.action === 'answer') {
        label = 'Question'
        text = t.attention?.question
      } else if (s.action === 'delivery') {
        label = 'Delivery error'
        text = t.delivery?.error
      } else if (latest?.environment && latest?.report?.state === 'blocked') {
        label = 'Environment blocked'
        text = latest.environment
      } else {
        label = 'Report'
        text = latestReport(t)?.summary
      }
    }
    return {
      ticketId: t.id,
      title: t.title,
      stage: stageLabel(t),
      ...(label ? { label } : {}),
      ...(text !== undefined ? { text } : {}),
      links,
      pulls,
    }
  }
  const person = open.filter(t => ticketStage(t).stage === 'person').map(item)
  const others = options.all
    ? [
        ...open.filter(t => ticketStage(t).stage !== 'person').map(item),
        ...rows<Ticket>(
          reader,
          "SELECT value FROM ticket WHERE open IS NULL AND value ->> '$.ended.at' >= ? ORDER BY rowid DESC",
          new Date(options.now - options.endedWithinMs).toISOString(),
        ).map(item),
      ]
    : []
  return { person, others }
}

export function formatNeeds(view: NeedsView, all: boolean): string {
  const lines: string[] = []
  const n = view.person.length
  lines.push(n === 0 ? 'Nothing needs you.' : n === 1 ? '1 ticket needs you:' : `${n} tickets need you:`)
  const block = (i: NeedItem): void => {
    lines.push(`- ${i.title} [${i.ticketId}] ${i.stage}`)
    if (i.label && i.text !== undefined) lines.push(`  ${i.label}: ${i.text}`)
    for (const link of i.links) lines.push(`  Link: ${link}`)
    for (const pull of i.pulls) lines.push(`  Pull request: ${pull}`)
  }
  for (const i of view.person) block(i)
  if (all) {
    lines.push(view.others.length ? `Other tickets (${view.others.length}):` : 'Other tickets: none')
    for (const i of view.others) block(i)
  }
  return lines.join('\n') + '\n'
}

export { redact } from '../infra/redact.ts'
