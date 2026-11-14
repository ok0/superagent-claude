/** A state database seeded for the status and needs commands, with the config file that points at it. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KV } from '../../src/app/kv.ts'
import { databasePath, Store } from '../../src/app/store.ts'
import { GITHUB_STATE } from '../../src/sources/github/source.ts'

export const TOKEN = 'ghp_' + 'A1b2C3d4'.repeat(5) // 44 chars
export const IDS = {
  running: 'a'.repeat(32),
  wait1: 'b'.repeat(32),
  wait2: 'c'.repeat(32),
  person: 'd'.repeat(32),
  ended: 'e'.repeat(32),
}

export function writeStateConfig(dir: string, extra?: Record<string, unknown>): string {
  const path = join(dir, 'issuecrew.json')
  writeFileSync(
    path,
    JSON.stringify({
      repositories: ['owner/repo', 'owner/other'],
      policy: { allowed: ['alice'] },
      stateDir: join(dir, 'state'),
      ...extra,
    }),
  )
  return path
}

export function seedState(
  dir: string,
  options: { only?: (keyof typeof IDS)[]; snapshot?: boolean } = {},
): { store: Store; configPath: string; now: number } {
  const configPath = writeStateConfig(dir)
  const now = Date.now()
  const iso = (ms: number): string => new Date(ms).toISOString()
  const include = (key: keyof typeof IDS): boolean => options.only === undefined || options.only.includes(key)
  mkdirSync(join(dir, 'state'), { recursive: true })
  const store = new Store(databasePath(join(dir, 'state')))
  const base = (key: keyof typeof IDS, title: string, assignments: unknown[]) => ({
    id: IDS[key],
    title,
    decisionId: 'd',
    mandate: {},
    channels: [],
    inputs: [],
    undelivered: [],
    origin: { triggerId: 'tr-' + key, triggerIds: ['tr-' + key] },
    createdAt: iso(now - 3_600_000),
    updatedAt: iso(now - 60_000),
    assignments,
  })

  if (include('running')) {
    store.tickets.save(
      base('running', 'Fix the flaky test', [
        {
          id: 'as-run',
          state: 'running',
          createdAt: iso(now - 120_000),
          startedAt: iso(now - 60_000),
          report: { state: 'progress', summary: 'Working on it', at: iso(now - 60_000) },
        },
      ]) as never,
    )
  }
  if (include('wait1')) {
    store.tickets.save(
      base('wait1', 'Update the docs', [{ id: 'as-wait1', state: 'pending', createdAt: iso(now - 30_000) }]) as never,
    )
  }
  if (include('wait2')) {
    store.tickets.save(
      base('wait2', 'Bump the version', [{ id: 'as-wait2', state: 'pending', createdAt: iso(now - 20_000) }]) as never,
    )
  }
  if (include('person')) {
    store.triggers.save({
      id: 'tr-person',
      source: 'github',
      at: iso(now - 90_000),
      human: true,
      url: 'https://github.com/owner/repo/issues/3#issuecomment-1',
      threads: [{ source: 'github', id: 'owner/repo#3' }],
      meta: {},
    } as never)
    store.threads.save({
      key: 'github:owner/repo#12',
      ref: { source: 'github', id: 'owner/repo#12' },
      meta: { url: 'https://github.com/owner/repo/pull/12' },
    } as never)
    store.tickets.save({
      ...base('person', 'Grant push access', [
        {
          id: 'as-person',
          state: 'ended',
          createdAt: iso(now - 600_000),
          report: { state: 'progress', summary: 'Waiting for the answer', at: iso(now - 300_000) },
        },
      ]),
      attention: { id: 'at1', question: 'Can you grant push access to owner/repo?', triggerId: 'tr-person' },
      follows: [{ thread: 'github:owner/repo#12', own: true }],
    } as never)
  }
  if (include('ended')) {
    store.tickets.save({
      ...base('ended', 'Old cleanup', []),
      ended: { at: iso(now - 86_400_000), by: 'executor', outcome: 'completed' },
    } as never)
  }
  store.db
    .prepare(
      "INSERT INTO effect (kind, key, value, seq, due, since, attempts, error) VALUES ('reply', 'm1', '{}', 1, 0, ?, 3, ?)",
    )
    .run(iso(now), 'HTTP 502 for https://x-access-token:' + TOKEN + '@example.test')
  if (options.snapshot !== false) {
    store.set(KV.health.snapshot, {
      at: iso(now - 2000),
      pid: 1,
      entries: {
        runtime: { state: 'ready', detail: 'Orchestrator is ready' },
        auth: {
          state: 'ready',
          detail: 'warning',
          values: { mode: 'subscription', consentAt: '2026-01-02T03:04:05.000Z', allowedHash: '0123456789abcdef' },
        },
        'github:owner/other': { state: 'error', detail: 'Not accessible: token ' + TOKEN, at: iso(now) },
      },
    })
  }
  store.set(GITHUB_STATE.access('owner/repo'), { accessible: true, push: true, at: iso(now - 5000) })
  store.set(GITHUB_STATE.access('owner/other'), {
    accessible: false,
    push: false,
    at: iso(now - 5000),
    error: 'Not Found (HTTP 404)',
  })
  return { store, configPath, now }
}
