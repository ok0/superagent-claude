import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli/main.ts'
import { HealthBoard, HealthRecorder, type HealthSnapshot } from '../src/infra/health.ts'
import { KV } from '../src/app/kv.ts'
import { REPOSITORY_ACCESS_PREFIX } from '../src/app/status.ts'
import { redact } from '../src/app/status.ts'
import { databasePath, Store } from '../src/app/store.ts'
import { openReadOnly, writerActive } from '../src/app/store-read.ts'
import { GITHUB_STATE } from '../src/sources/github/source.ts'
import { cliEnv, cliIo } from './fixtures/cli.ts'
import { IDS, seedState, TOKEN, writeStateConfig } from './fixtures/state.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'status-'))
  dirs.push(dir)
  return dir
}

function io(dir: string) {
  return cliIo(dir, cliEnv(dir, { ISSUECREW_GITHUB_TOKEN: TOKEN }))
}

describe('status', () => {
  it('shows running work, waiting tickets, errors, repository access and consent without secrets while the writer holds the lock', async () => {
    const dir = tempDir()
    const { store, configPath } = seedState(dir)
    const { io: cli, out } = io(dir)
    expect(await main(['status', '--config', configPath], cli)).toBe(0)
    const text = out.join('')
    expect(text).toContain('Daemon: running')
    expect(text).toContain('Running assignments (1):')
    expect(text).toContain(IDS.running)
    expect(text).toContain('Idle sessions: none')
    expect(text).toContain('Waiting tickets (2):')
    expect(text).toContain(IDS.wait1)
    expect(text).toContain(IDS.wait2)
    expect(text).toContain('Recent errors (2):')
    expect(text).toContain('health github:owner/other')
    expect(text).toContain('effect reply m1')
    expect(text).toContain('owner/repo  accessible, push allowed')
    expect(text).toContain('owner/other  not accessible: Not Found (HTTP 404)')
    expect(text).toContain(
      'Subscription consent: given at 2026-01-02T03:04:05.000Z (allowed list hash 0123456789abcdef)',
    )
    expect(text).not.toContain(TOKEN)
    store.close()
  })

  it('shows an idle session apart from running work, and as running again while a message waits or was read after it went idle', async () => {
    const dir = tempDir()
    const { store, configPath, now } = seedState(dir, { only: ['running'] })
    const iso = (ms: number) => new Date(ms).toISOString()
    const ticket = store.tickets.get(IDS.running)!
    const a = ticket.assignments[0]!
    a.report = { state: 'ready', summary: 'Opened the pull request', at: iso(now - 50_000) }
    a.idleAt = iso(now - 40_000)
    ticket.inputs = [
      {
        id: 'in-1',
        kind: 'trigger',
        triggerId: 'tr-1',
        at: iso(now - 70_000),
        human: true,
        readAt: iso(now - 65_000),
        deliveredTo: a.id,
      },
    ] as never
    store.tickets.save(ticket)
    const run = async () => {
      const { io: cli, out } = io(dir)
      expect(await main(['status', '--config', configPath], cli)).toBe(0)
      return out.join('')
    }
    const first = await run()
    expect(first).toContain('Idle sessions (1):')
    expect(first).toContain(`${IDS.running}  Fix the flaky test  idle since ${a.idleAt}`)
    expect(first).toContain('Running assignments: none')
    ticket.inputs.push({
      id: 'in-2',
      kind: 'trigger',
      triggerId: 'tr-2',
      at: iso(now - 30_000),
      human: true,
      readAt: null,
      deliveredTo: a.id,
    } as never)
    store.tickets.save(ticket)
    const unread = await run()
    expect(unread).toContain('Running assignments (1):')
    expect(unread).toContain('Idle sessions: none')
    ;(ticket.inputs.at(-1) as { readAt?: string | null }).readAt = iso(now - 20_000)
    store.tickets.save(ticket)
    const readAfter = await run()
    expect(readAfter).toContain('Running assignments (1):')
    expect(readAfter).toContain('Idle sessions: none')
    a.idleAt = iso(now - 10_000)
    store.tickets.save(ticket)
    const nextTurn = await run()
    expect(nextTurn).toContain('Idle sessions (1):')
    store.close()
  })

  it('says the daemon is not running once the writer closed', async () => {
    const dir = tempDir()
    const { store, configPath } = seedState(dir)
    store.close()
    const { io: cli, out } = io(dir)
    expect(await main(['status', '--config', configPath], cli)).toBe(0)
    expect(out.join('')).toContain('Daemon: not running')
  })

  it('shows consent as not applicable without a recorded consent', async () => {
    const dir = tempDir()
    const { store, configPath } = seedState(dir)
    store.set(KV.health.snapshot, {
      at: new Date().toISOString(),
      pid: 1,
      entries: { auth: { state: 'ready', detail: 'ok', values: { mode: 'api-key' } } },
    })
    const { io: cli, out } = io(dir)
    expect(await main(['status', '--config', configPath], cli)).toBe(0)
    expect(out.join('')).toContain('Subscription consent: not applicable (auth.mode api-key)')
    store.close()
  })

  it('ends with one line and exit 3 when there is no state database', async () => {
    const dir = tempDir()
    const configPath = writeStateConfig(dir)
    const { io: cli, out, err } = io(dir)
    expect(await main(['status', '--config', configPath], cli)).toBe(3)
    const text = err.join('').trim()
    expect(text.split('\n')).toHaveLength(1)
    expect(text).toContain('no state database')
    expect(text).not.toMatch(/\n\s+at /)
    expect(out).toEqual([])
  })

  it('refuses a missing config and an unknown option with exit 2', async () => {
    const dir = tempDir()
    const missing = io(dir)
    expect(await main(['status', '--config', join(dir, 'missing.json')], missing.io)).toBe(2)
    expect(missing.err.join('')).toContain('issuecrew:')
    const unknown = io(dir)
    expect(await main(['status', '--bogus'], unknown.io)).toBe(2)
    expect(unknown.err.join('')).toContain("unknown option '--bogus'")
  })
})

describe('needs while the writer holds the lock', () => {
  it('needs answers while the writer holds the lock', async () => {
    const dir = tempDir()
    const { store, configPath } = seedState(dir)
    const { io: cli } = io(dir)
    expect(await main(['needs', '--config', configPath], cli)).toBe(0)
    store.close()
  })
})

describe('HealthRecorder', () => {
  it('writes at most once per interval unless forced', () => {
    const board = new HealthBoard()
    board.claim('runtime', { state: 'ready', detail: 'ok' })
    const written: HealthSnapshot[] = []
    let clock = Date.parse('2026-03-01T00:00:00.000Z')
    const recorder = new HealthRecorder(
      board,
      snapshot => {
        written.push(snapshot)
      },
      () => clock,
    )
    expect(recorder.record()).toBe(true)
    clock += 1000
    expect(recorder.record()).toBe(false)
    clock += 4000
    expect(recorder.record()).toBe(true)
    expect(recorder.record(true)).toBe(true)
    expect(written).toHaveLength(3)
    expect(written[0]!.at).toBe('2026-03-01T00:00:00.000Z')
    expect(written[0]!.entries.runtime).toEqual({ state: 'ready', detail: 'ok' })
  })
})

describe('redact', () => {
  it('masks secret env values, token literals, and access-token URLs, and keeps short values', () => {
    const env = { ISSUECREW_GITHUB_TOKEN: 'secret-value-123', API_KEY: 'short' }
    expect(redact('a secret-value-123 b', env)).toBe('a *** b')
    expect(redact(TOKEN, {})).toBe('***')
    expect(redact('fine_pat_' + 'A1b2C3d4E5f6G7h8', {})).toBe('***')
    expect(redact('sk-ant-' + 'abcdefgh1234', {})).toBe('***')
    expect(redact('x-access-token:abc@h', {})).toBe('x-access-token:***@h')
    expect(redact('short', env)).toBe('short')
  })
})

describe('repository access family and writer lock', () => {
  it('reads the repository access family the Source writes', () => {
    expect(REPOSITORY_ACCESS_PREFIX).toBe(GITHUB_STATE.access.prefix)
  })

  it('writerActive is true only while a Store is open', () => {
    const dir = tempDir()
    const db = databasePath(join(dir, 'state'))
    expect(writerActive(db)).toBe(false)
    const store = new Store(db)
    expect(writerActive(db)).toBe(true)
    store.close()
    expect(writerActive(db)).toBe(false)
    expect(writerActive(join(dir, 'missing.db'))).toBe(false)
  })

  it('openReadOnly keys lists the repository access keys sorted', () => {
    const dir = tempDir()
    const { store } = seedState(dir)
    const reader = openReadOnly(databasePath(join(dir, 'state')))
    expect(reader.keys('repo-access:')).toEqual(['repo-access:owner/other', 'repo-access:owner/repo'])
    reader.close()
    store.close()
  })
})
