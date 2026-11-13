/**
 * SIGTERM while an Assignment runs: readiness off, running work recorded as interrupted, exit 0 within 15 s; the
 * restart resumes it with the recovery note and posts no comment twice.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { databasePath, type Receipt } from '../src/app/store.ts'
import { openReadOnly } from '../src/app/store-read.ts'
import { key, type Ticket } from '../src/core/index.ts'
import { cliEnv } from './fixtures/cli.ts'
import { issue, notification, type FakeGhScript, type Posted } from './fixtures/fake-gh.ts'
import { fileGh, NOW, type FileGh } from './fixtures/file-gh.ts'

const A = 'acme/widgets'
const ISSUE_PATH = 'issues/1/comments'
const MARKER = /<!-- superagent-claude:(.+?) -->/
const poll = (check: () => boolean, timeout: number): Promise<void> =>
  vi.waitFor(
    () => {
      if (!check()) throw new Error('not yet')
    },
    { timeout, interval: 100 },
  )
const dirs: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Daemon {
  child: ChildProcess
  exited: boolean
  code: number | null
  signal: NodeJS.Signals | null
  out: string
  err: string
}
interface Setup {
  dir: string
  cfg: string
  gh: FileGh
}

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'sigterm-restart-'))
  dirs.push(dir)
  const script: FakeGhScript = {
    repositories: {
      [A]: {
        notifications: [notification(A, 1)],
        issues: { 1: issue(A, 1, { body: '@agent-bot please fix the typo', created_at: NOW, updated_at: NOW }) },
      },
    },
  }
  const gh = fileGh(dir, script)
  const cfg = join(dir, 'superagent-claude.json')
  writeFileSync(
    cfg,
    JSON.stringify({
      repositories: [A],
      policy: { allowed: ['alice'], acceptMode: 'auto' },
      security: { allowUnsandboxed: true },
      stateDir: join(dir, 'state'),
    }),
  )
  return { dir, cfg, gh }
}

function entry(): string {
  return process.env.SUPERAGENT_CLAUDE_CLI ?? fileURLToPath(new URL('../src/cli/bin.ts', import.meta.url))
}

function daemon(t: Setup, extra: Record<string, string> = {}): Daemon {
  const child = spawn(process.execPath, [entry(), 'start', '--fake', '--config', t.cfg], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...cliEnv(t.dir, { PATH: `${t.gh.bin}:/usr/bin:/bin`, ...t.gh.env, ...extra }),
    } as NodeJS.ProcessEnv,
  })
  children.push(child)
  const d: Daemon = { child, exited: false, code: null, signal: null, out: '', err: '' }
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    d.out += chunk
  })
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    d.err += chunk
  })
  child.once('exit', (code, signal) => {
    d.exited = true
    d.code = code
    d.signal = signal
  })
  return d
}

function health(t: Setup, mode: 'live' | 'ready'): number | null {
  return spawnSync(process.execPath, [entry(), 'health', `--${mode}`, '--config', t.cfg], {
    env: { ...process.env, ...cliEnv(t.dir, { PATH: `${t.gh.bin}:/usr/bin:/bin`, ...t.gh.env }) } as NodeJS.ProcessEnv,
  }).status
}

function read<T = Record<string, any>>(dir: string, sql: string, ...params: string[]): T[] {
  const reader = openReadOnly(databasePath(join(dir, 'state')))
  try {
    return reader.db.prepare(sql).all(...params) as T[]
  } finally {
    reader.close()
  }
}

const tickets = (dir: string): Ticket[] =>
  read<{ value: string }>(dir, 'SELECT value FROM ticket').map(row => JSON.parse(row.value) as Ticket)
const receipts = (dir: string): Receipt[] =>
  read<{ value: string }>(dir, 'SELECT value FROM outbox').map(row => JSON.parse(row.value) as Receipt)
const effectKeys = (dir: string, kind: string): string[] =>
  read<{ key: string }>(dir, 'SELECT key FROM effect WHERE kind = ?', kind).map(row => row.key)
const markers = (posted: Posted[]): string[] => posted.map(post => MARKER.exec(post.body)?.[1] ?? '')
const events = (text: string): { event: string; tickets?: string[] }[] =>
  text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as { event: string; tickets?: string[] })

function delivered(t: Setup): boolean {
  const posted = t.gh.read().posted
  if (posted.length === 0) return false
  const list = receipts(t.dir)
  return (
    markers(posted).every(id => list.find(receipt => receipt.id === id)?.status === 'sent') &&
    list.every(receipt => receipt.status !== 'pending') &&
    effectKeys(t.dir, 'reply').length === 0
  )
}

function runningTicket(dir: string): { ticket: Ticket; running: string } | undefined {
  for (const ticket of tickets(dir)) {
    const running = ticket.assignments.find(assignment => assignment.state === 'running')
    if (running) return { ticket, running: running.id }
  }
  return undefined
}

describe('daemon SIGTERM stop', () => {
  it('a daemon stopped by SIGTERM while its Assignment runs exits 0 within 15 seconds and the restart resumes it once', async () => {
    const t = setup()
    const d1 = daemon(t, { SUPERAGENT_CLAUDE_FAKE_HOLD: '1' })
    await poll(() => runningTicket(t.dir) !== undefined, 60_000)
    const { ticket: seen, running: runningId } = runningTicket(t.dir)!
    const ticketId = seen.id
    const createdAt = seen.createdAt
    expect(health(t, 'live')).toBe(0)
    expect(health(t, 'ready')).toBe(0)

    const t0 = Date.now()
    d1.child.kill('SIGTERM')
    await poll(() => d1.exited, 15_000)
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(d1.code, d1.err).toBe(0)
    expect(d1.signal).toBeNull()

    const names = events(d1.out).map(record => record.event)
    const stopping = names.indexOf('runtime.stopping')
    const interrupted = names.indexOf('runtime.interrupted')
    const stopped = names.indexOf('runtime.stopped')
    expect(stopping).toBeGreaterThanOrEqual(0)
    expect(interrupted).toBeGreaterThan(stopping)
    expect(stopped).toBeGreaterThan(interrupted)
    expect(events(d1.out)[interrupted]!.tickets).toContain(ticketId)
    expect(read(t.dir, "SELECT value FROM kv WHERE key = 'runtime-ready'")).toEqual([])
    expect(health(t, 'ready')).toBe(1)

    const before = tickets(t.dir)[0]!
    expect(before.assignments.find(assignment => assignment.id === runningId)).toMatchObject({
      state: 'ended',
      endedReason: 'hostRestarted',
    })
    expect(before.assignments.at(-1)).toMatchObject({ state: 'pending' })
    expect(t.gh.read().posted).toEqual([])

    const d2 = daemon(t)
    await poll(() => d2.exited || (tickets(t.dir)[0]?.ended !== undefined && delivered(t)), 60_000)
    expect(d2.exited, d2.err).toBe(false)
    expect(d2.err).not.toContain('Another superagent-claude process')
    d2.child.kill('SIGTERM')
    await poll(() => d2.exited, 15_000)
    expect(d2.code, d2.err).toBe(0)

    const list = tickets(t.dir)
    expect(list).toHaveLength(1)
    const ticket = list[0]!
    expect(ticket.id).toBe(ticketId)
    expect(ticket.createdAt).toBe(createdAt)
    expect(ticket.assignments.find(assignment => assignment.id === runningId)).toMatchObject({
      state: 'ended',
      endedReason: 'hostRestarted',
    })
    const later = ticket.assignments.find(assignment => assignment.id !== runningId)!
    expect(later).toBeDefined()
    const restart = ticket.inputs.find(input => input.id === key('input', ticketId, 'restart', later.id))!
    expect(restart).toMatchObject({ kind: 'text' })
    expect((restart as { text: string }).text).toContain('The host restarted')
    expect(ticket.undelivered).not.toContain(restart.id)
    expect(effectKeys(t.dir, 'launch')).toEqual([])

    const posted = t.gh.read().posted
    expect(posted).toHaveLength(1)
    expect(posted[0]!.path).toBe(ISSUE_PATH)
    const ids = markers(posted)
    expect(new Set(ids).size).toBe(posted.length)
    expect(new Set(posted.map(post => post.body)).size).toBe(posted.length)
    expect(receipts(t.dir).find(receipt => receipt.id === ids[0])?.status).toBe('sent')
  }, 120_000)
})
