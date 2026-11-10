import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Retention } from '../src/app/retention.ts'
import { Store, databasePath } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'
import { WorkerStore } from '../src/executor/worker-store.ts'
import { Workspaces, type WorkspaceProvider } from '../src/executor/workspaces.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400_000
const START = Date.parse('2026-03-01T00:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const ids = { old: 'a'.repeat(32), recent: 'b'.repeat(32), open: 'c'.repeat(32) }

function ticket(id: string, ended?: string): Ticket {
  return {
    id, title: id, decisionId: 'd', mandate: {}, channels: [], assignments: [], inputs: [], undelivered: [],
    createdAt: iso(START), updatedAt: iso(START), origin: { triggerId: 't', triggerIds: ['t'] },
    ...(ended ? { ended: { at: ended, by: 'executor', outcome: 'completed' } } : {}),
  } as unknown as Ticket
}

function harness(wrap?: (ws: Workspaces) => Pick<WorkspaceProvider, 'remove'>) {
  const dir = mkdtempSync(join(tmpdir(), 'retention-'))
  dirs.push(dir)
  const env = { PATH: process.env.PATH!, HOME: join(dir, 'home'), LANG: 'C' }
  mkdirSync(env.HOME, { recursive: true })
  const sh = (args: string[], cwd: string): string =>
    execFileSync('git', args, { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' })
  const origin = join(dir, 'origin.git')
  sh(['init', '--bare', '-b', 'main', origin], dir)
  const repo = join(dir, 'seed')
  sh(['init', '-b', 'main', repo], dir)
  writeFileSync(join(repo, 'README.md'), 'hello')
  sh(['add', '-A'], repo)
  sh(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], repo)
  sh(['push', origin, 'main'], repo)
  const commands = new Commands({ apiProgram: 'gh', baseEnv: env, env: { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } })
  const stateDir = join(dir, 'state')
  const ws = new Workspaces({ stateDir, commands, repositoryOf: () => 'owner/repo', access: { remote: () => origin, env: () => ({}), secrets: [] } })
  const workspaces = wrap ? wrap(ws) : ws
  const time = { now: START, days: 14 }

  const open = () => {
    const store = new Store(databasePath(stateDir))
    const effects = new Effects(store, new HealthBoard(), () => time.now)
    const workers = new WorkerStore(store, () => time.now)
    const retention = new Retention({ store, effects, workspaces, workers, days: () => time.days, now: () => time.now })
    return { store, effects, workers, retention }
  }

  async function seed(s: ReturnType<typeof open>, id: string, ended?: string): Promise<void> {
    s.store.tickets.save(ticket(id, ended))
    const prepared = await ws.prepare(ticket(id, ended), id)
    s.workers.put({
      ticketId: id, assignmentId: 'as-' + id.slice(0, 4), runtime: 'fake', sessionId: null, repository: 'owner/repo',
      cwd: prepared.cwd, branch: prepared.branch, pushRemote: null, turns: 0, costUsd: 0, promptVersion: null,
    })
  }

  const worktrees = () => sh(['worktree', 'list'], ws.clonePath('owner/repo'))
  return { ws, time, open, seed, worktrees }
}

describe('retention', () => {
  it('removes the worktree and worker record of a ticket ended longer ago than endedTicketDays, and keeps a recent ended and an open ticket', async () => {
    const h = harness()
    const s = h.open()
    await h.seed(s, ids.old, iso(START - 15 * DAY))
    await h.seed(s, ids.recent, iso(START - DAY))
    await h.seed(s, ids.open)
    expect(s.retention.evaluate()).toBe(1)
    s.effects.start()
    await s.effects.idle('cleanup')
    expect(existsSync(h.ws.worktreePath(ids.old))).toBe(false)
    expect(s.workers.get(ids.old)).toBeUndefined()
    expect(h.worktrees()).not.toContain(ids.old)
    expect(existsSync(h.ws.worktreePath(ids.recent))).toBe(true)
    expect(existsSync(h.ws.worktreePath(ids.open))).toBe(true)
    expect(s.workers.get(ids.recent)).toBeDefined()
    expect(s.workers.get(ids.open)).toBeDefined()
    s.store.close()
  })

  it('applies a changed endedTicketDays on the next evaluation', async () => {
    const h = harness()
    const s = h.open()
    await h.seed(s, ids.old, iso(START - 15 * DAY))
    await h.seed(s, ids.recent, iso(START - DAY))
    await h.seed(s, ids.open)
    expect(s.retention.evaluate()).toBe(1)
    s.effects.start()
    await s.effects.idle('cleanup')
    h.time.days = 1
    expect(s.retention.evaluate()).toBe(1)
    await s.effects.idle('cleanup')
    expect(existsSync(h.ws.worktreePath(ids.recent))).toBe(false)
    expect(s.workers.get(ids.recent)).toBeUndefined()
    expect(existsSync(h.ws.worktreePath(ids.open))).toBe(true)
    expect(s.workers.get(ids.open)).toBeDefined()
    s.store.close()
  })

  it('repeating cleanup is harmless and gives the same result', async () => {
    const h = harness()
    const s = h.open()
    await h.seed(s, ids.old, iso(START - 15 * DAY))
    await h.seed(s, ids.recent, iso(START - DAY))
    await s.retention.cleanup(ids.old)
    await expect(s.retention.cleanup(ids.old)).resolves.toBeUndefined()
    expect(existsSync(h.ws.worktreePath(ids.old))).toBe(false)
    expect(s.workers.get(ids.old)).toBeUndefined()
    expect(existsSync(h.ws.worktreePath(ids.recent))).toBe(true)
    expect(s.retention.evaluate()).toBe(0)
    s.store.close()
  })

  it('a failed cleanup is retried and ends as one cleanup', async () => {
    let fail = 1
    const h = harness(ws => ({ remove: async id => { if (fail-- > 0) throw new Error('disk busy'); return ws.remove(id) } }))
    const s = h.open()
    await h.seed(s, ids.old, iso(START - 15 * DAY))
    expect(s.retention.evaluate()).toBe(1)
    s.effects.start()
    await s.effects.idle('cleanup')
    expect(s.store.db.prepare("SELECT attempts FROM effect WHERE kind = 'cleanup'").get()?.attempts).toBe(1)
    expect(existsSync(h.ws.worktreePath(ids.old))).toBe(true)
    h.time.now += 3000
    s.effects.kick()
    await s.effects.idle('cleanup')
    expect(s.store.db.prepare("SELECT COUNT(*) AS n FROM effect WHERE kind = 'cleanup'").get()?.n).toBe(0)
    expect(existsSync(h.ws.worktreePath(ids.old))).toBe(false)
    expect(s.workers.get(ids.old)).toBeUndefined()
    s.store.close()
  })

  it('a queued cleanup survives a restart', async () => {
    const h = harness()
    const s = h.open()
    await h.seed(s, ids.old, iso(START - 15 * DAY))
    expect(s.retention.evaluate()).toBe(1)
    s.store.close()
    const r = h.open()
    r.effects.start()
    await r.effects.idle('cleanup')
    expect(existsSync(h.ws.worktreePath(ids.old))).toBe(false)
    expect(r.workers.get(ids.old)).toBeUndefined()
    r.store.close()
  })

  it('leaves a ticket that resumed before its cleanup ran', async () => {
    const h = harness()
    const s = h.open()
    await h.seed(s, ids.old, iso(START - 15 * DAY))
    expect(s.retention.evaluate()).toBe(1)
    s.store.tickets.save(ticket(ids.old))
    s.effects.start()
    await s.effects.idle('cleanup')
    expect(existsSync(h.ws.worktreePath(ids.old))).toBe(true)
    expect(s.workers.get(ids.old)).toBeDefined()
    s.store.close()
  })

  it('does not queue a ticket whose ended time does not parse', async () => {
    const h = harness()
    const s = h.open()
    await h.seed(s, ids.old, 'unknown')
    expect(s.retention.evaluate()).toBe(0)
    s.store.close()
  })
})
