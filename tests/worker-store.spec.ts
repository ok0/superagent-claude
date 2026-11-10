/**
 * The worker table: session records, usage summed per Assignment, and the schema version that declares the table.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import { WorkerStore } from '../src/executor/worker-store.ts'

let directory: string
let store: Store
let workers: WorkerStore
const now = () => Date.parse('2026-09-23T00:00:00Z')
const rec = { ticketId: 't1', assignmentId: 'a1', runtime: 'fake', sessionId: 's1', repository: 'owner/repo', cwd: '/work/t1', branch: 'agent/t1', pushRemote: null, turns: 0, costUsd: 0, promptVersion: 'p1' }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'worker-store-'))
  store = new Store(join(directory, 'db.sqlite'))
  workers = new WorkerStore(store, now)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('puts, gets and clears a worker record', () => {
  workers.put(rec)
  expect(workers.get('t1')).toEqual({ ...rec, updatedAt: '2026-09-23T00:00:00.000Z' })
  workers.clear('t1')
  expect(workers.get('t1')).toBeUndefined()
})

it('keeps records and usage after the store is reopened', () => {
  workers.put(rec)
  expect(workers.addUsage('t1', 'a1', 2, 0.5)).toEqual({ turns: 2, costUsd: 0.5 })
  expect(workers.addUsage('t1', 'a1', 3, 1.25)).toEqual({ turns: 5, costUsd: 1.75 })
  store.close()
  store = new Store(join(directory, 'db.sqlite'))
  workers = new WorkerStore(store, now)
  const record = workers.get('t1')
  expect(record?.turns).toBe(5)
  expect(record?.costUsd).toBe(1.75)
  expect(record?.sessionId).toBe('s1')
})

it('starts usage over for another Assignment', () => {
  workers.put(rec)
  workers.addUsage('t1', 'a1', 2, 0.5)
  expect(workers.addUsage('t1', 'a2', 1, 0.25)).toEqual({ turns: 1, costUsd: 0.25 })
  expect(workers.get('t1')?.assignmentId).toBe('a2')
})

it('records the session id', () => {
  workers.put(rec)
  workers.setSession('t1', 's2')
  expect(workers.get('t1')?.sessionId).toBe('s2')
})

it('setPromptVersion updates only the prompt version', () => {
  workers.put({ ...rec, promptVersion: 'v1' })
  workers.setPromptVersion('t1', 'v2')
  expect(workers.get('t1')).toEqual({ ...rec, promptVersion: 'v2', updatedAt: '2026-09-23T00:00:00.000Z' })
})

it('declares the worker table in schema version 1', () => {
  expect(SCHEMA_VERSION).toBe(1)
  expect(store.db.prepare("SELECT name FROM pragma_table_info('worker')").all().map(row => row.name)).toEqual([
    'ticket_id', 'assignment_id', 'runtime', 'session_id', 'repository', 'cwd', 'branch', 'push_remote', 'turns', 'cost_usd', 'prompt_version', 'updated_at',
  ])
})
