/** KV keys, Versions and the in-memory TextCache across a Store reopen (M6 AC8). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store, databasePath } from '../src/app/store.ts'
import { KV, family, record } from '../src/app/kv.ts'
import { TextCache } from '../src/app/cache.ts'
import { Versions } from '../src/app/versions.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'superagent-claude-kv-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it('keeps KV records across a reopen, and holds only the reference keys without source-specific families', () => {
  const store = new Store(databasePath(directory))
  store.set(KV.runtime.masterId, 'm')
  store.set(KV.sources.labels('chat'), { a: 'A' })
  store.set(KV.sessions.prompts('router'), [1, 2])
  store.close()
  const reopened = new Store(databasePath(directory))
  expect(reopened.get(KV.runtime.masterId)).toBe('m')
  expect(reopened.get(KV.sources.labels('chat'))).toEqual({ a: 'A' })
  expect(reopened.get(KV.sessions.prompts('router'))).toEqual([1, 2])
  expect(reopened.keys(KV.sources.labels)).toEqual(['source-labels:chat'])
  expect(Object.keys(KV)).toEqual(['health', 'store', 'runtime', 'sessions', 'sources'])
  expect(Object.values(KV).flatMap(group => Object.values(group).map(entry => typeof entry === 'string' ? entry : entry.prefix)))
    .toEqual(['health', 'schema', 'master-id', 'router-prompt-version', 'session-prompts:', 'source-labels:'])
  reopened.close()
})

it('keeps versions across a reopen and never rewrites an earlier revision', () => {
  const note = (store: Store) => new Versions<{ revision: number; value: string }>(store, record<number>('note-revision'), family<{ revision: number; value: string }, [revision: number]>('note-version:'))
  const store = new Store(databasePath(directory))
  note(store).save(revision => ({ revision, value: 'a' }))
  note(store).save(revision => ({ revision, value: 'b' }))
  store.close()
  const reopened = new Store(databasePath(directory))
  const versions = note(reopened)
  expect(versions.get(1)).toEqual({ revision: 1, value: 'a' })
  expect(versions.revision()).toBe(2)
  const before = [versions.get(1), versions.get(2)]
  versions.save(revision => ({ revision, value: 'c' }))
  expect([versions.get(1), versions.get(2)]).toEqual(before)
  expect(versions.list().length).toBe(3)
  reopened.close()
})

it('keeps cached texts in memory only, as the reference cache does', () => {
  new TextCache(100).set('a', 'x')
  expect(new TextCache(100).get('a')).toBeUndefined()
})
