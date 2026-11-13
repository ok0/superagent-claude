/**
 * Daemon-level forced stops: `start --fake` as a child process over the file-backed fake gh, SIGKILLed
 * while an Assignment runs or around a reply post, restarted on the same stateDir.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../src/app/config.ts'
import { Effects } from '../src/app/effects.ts'
import { databasePath, Store, type Receipt } from '../src/app/store.ts'
import { openReadOnly } from '../src/app/store-read.ts'
import { key, type Ticket } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
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
  const dir = mkdtempSync(join(tmpdir(), 'crash-restart-'))
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

function daemon(t: Setup, extra: Record<string, string> = {}): Daemon {
  const entry = process.env.SUPERAGENT_CLAUDE_CLI ?? fileURLToPath(new URL('../src/cli/bin.ts', import.meta.url))
  const child = spawn(process.execPath, [entry, 'start', '--fake', '--config', t.cfg], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...cliEnv(t.dir, { ...t.gh.env, ...extra }),
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

async function stop(d: Daemon): Promise<void> {
  expect(d.exited, d.err).toBe(false)
  d.child.kill('SIGINT')
  await poll(() => d.exited, 30_000)
  expect(d.code, d.err).toBe(0)
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
const threadKeys = (dir: string): string[] => read<{ key: string }>(dir, 'SELECT key FROM thread').map(row => row.key)
const markers = (posted: Posted[]): string[] => posted.map(post => MARKER.exec(post.body)?.[1] ?? '')

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

describe('daemon forced stops', () => {
  it('a daemon stopped by SIGKILL while its Assignment runs resumes it with the recovery note and posts no comment twice', async () => {
    const t = setup()
    const d1 = daemon(t, { SUPERAGENT_CLAUDE_FAKE_HOLD: '1' })
    await poll(() => runningTicket(t.dir) !== undefined, 60_000)
    const { ticket: seen, running: runningId } = runningTicket(t.dir)!
    const ticketId = seen.id
    const createdAt = seen.createdAt
    const keysAtKill = threadKeys(t.dir)

    d1.child.kill('SIGKILL')
    await poll(() => d1.exited, 30_000)
    expect(d1.signal).toBe('SIGKILL')
    expect(t.gh.read().posted).toEqual([])

    const d2 = daemon(t)
    await poll(() => d2.exited || (tickets(t.dir)[0]?.ended !== undefined && delivered(t)), 60_000)
    expect(d2.exited, d2.err).toBe(false)
    expect(d2.err).not.toContain('Another superagent-claude process')
    await stop(d2)

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
    const keysNow = threadKeys(t.dir)
    for (const keyValue of keysAtKill) expect(keysNow).toContain(keyValue)
    expect(effectKeys(t.dir, 'launch')).toEqual([])

    const posted = t.gh.read().posted
    expect(posted).toHaveLength(1)
    expect(posted[0]!.path).toBe(ISSUE_PATH)
    const ids = markers(posted)
    expect(new Set(ids).size).toBe(posted.length)
    expect(new Set(posted.map(post => post.body)).size).toBe(posted.length)
    expect(receipts(t.dir).find(receipt => receipt.id === ids[0])?.status).toBe('sent')
  }, 120_000)

  it('a reply posted just before a SIGKILL is found by its marker after restart and not posted again', async () => {
    const t = setup()
    t.gh.kill({ when: 'afterPost', path: ISSUE_PATH })
    const d1 = daemon(t)
    await poll(() => d1.exited, 60_000)
    expect(d1.signal).toBe('SIGKILL')

    const before = t.gh.read()
    expect(before.posted).toHaveLength(1)
    expect(before.killed?.when).toBe('afterPost')
    const id = markers(before.posted)[0]!
    expect(receipts(t.dir).find(receipt => receipt.id === id)?.status).toBe('pending')
    expect(effectKeys(t.dir, 'reply')).toEqual([id])

    const d2 = daemon(t)
    await poll(
      () => d2.exited || (receipts(t.dir).find(receipt => receipt.id === id)?.status === 'sent' && delivered(t)),
      60_000,
    )
    expect(d2.exited, d2.err).toBe(false)
    await stop(d2)

    expect(t.gh.read().posted).toHaveLength(1)
    expect(receipts(t.dir).find(receipt => receipt.id === id)?.status).toBe('sent')
  }, 120_000)

  it('a reply whose post a SIGKILL cut off is posted exactly once after restart', async () => {
    const t = setup()
    t.gh.kill({ when: 'beforePost', path: ISSUE_PATH })
    const d1 = daemon(t)
    await poll(() => d1.exited, 60_000)
    expect(d1.signal).toBe('SIGKILL')

    expect(t.gh.read().posted).toHaveLength(0)
    const pending = receipts(t.dir).filter(receipt => receipt.status === 'pending')
    expect(pending).toHaveLength(1)
    const id = pending[0]!.id
    expect(effectKeys(t.dir, 'reply')).toEqual([id])

    const d2 = daemon(t)
    await poll(
      () => d2.exited || (receipts(t.dir).find(receipt => receipt.id === id)?.status === 'sent' && delivered(t)),
      60_000,
    )
    expect(d2.exited, d2.err).toBe(false)
    await stop(d2)

    const posted = t.gh.read().posted
    expect(posted).toHaveLength(1)
    expect(markers(posted)[0]).toBe(id)
    expect(receipts(t.dir).find(receipt => receipt.id === id)?.status).toBe('sent')
  }, 120_000)

  it('an effect of a transaction a SIGKILL cut off never runs, and a committed one runs once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crash-store-'))
    dirs.push(dir)
    const dbPath = join(dir, 'db.sqlite')
    const crashScript = fileURLToPath(new URL('./fixtures/crash-store.ts', import.meta.url))
    const child = spawn(process.execPath, ['--no-warnings', crashScript, dbPath], { stdio: 'ignore' })
    children.push(child)
    const signal = await new Promise<NodeJS.Signals | null>(resolve => child.once('exit', (_code, sig) => resolve(sig)))
    expect(signal).toBe('SIGKILL')

    const store = new Store(dbPath)
    const keys = (store.db.prepare("SELECT key FROM effect WHERE kind = 'reply'").all() as { key: string }[]).map(
      row => row.key,
    )
    expect(keys).toEqual(['committed'])
    const effects = new Effects(store, new HealthBoard())
    const runs: string[] = []
    effects.handle('reply', async (_payload, runKey) => {
      runs.push(runKey)
    })
    effects.start()
    await effects.idle('reply')
    expect(runs).toEqual(['committed'])
    await effects.drain()
    store.close()

    const reopened = new Store(dbPath)
    const again = new Effects(reopened, new HealthBoard())
    again.handle('reply', async (_payload, runKey) => {
      runs.push(runKey)
    })
    again.start()
    await again.idle('reply')
    expect(runs).toEqual(['committed'])
    expect(
      Number(
        (reopened.db.prepare("SELECT COUNT(*) AS n FROM effect WHERE kind = 'reply'").get() as { n: number | bigint })
          .n,
      ),
    ).toBe(0)
    await again.drain()
    reopened.close()
  }, 30_000)

  it('the crash injection lives only in test fixtures and no config key is added', () => {
    const srcRoot = fileURLToPath(new URL('../src', import.meta.url))
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap(name => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : []
      })
    const files = walk(srcRoot)
    const contents = new Map(files.map(file => [relative(repoRoot, file), readFileSync(file, 'utf8')] as const))

    for (const [file, text] of contents) {
      expect(text.includes('process.ppid'), file).toBe(false)
      // child-process cleanup escalation (SIGTERM then SIGKILL), not crash injection
      if (file !== 'src/runtimes/claude/children.ts') expect(text.includes("'SIGKILL'"), file).toBe(false)
    }
    const names = [
      ...new Set(
        [...contents.values()].flatMap(text =>
          [...text.matchAll(/SUPERAGENT_CLAUDE_[A-Z][A-Z_]*/g)].map(match => match[0]),
        ),
      ),
    ]
    expect(names.filter(name => /CRASH|KILL|FAULT|INJECT/.test(name))).toEqual([])
    const holders = [...contents]
      .filter(([, text]) => text.includes('SUPERAGENT_CLAUDE_FAKE_HOLD'))
      .map(([file]) => file)
    expect(holders).toEqual(['src/cli/main.ts'])
    expect(Object.keys(ConfigSchema.shape)).toEqual([
      'repositories',
      'policy',
      'auth',
      'delivery',
      'workers',
      'network',
      'security',
      'retention',
      'models',
      'review',
      'stateDir',
    ])
  })
})
