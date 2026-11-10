// Ported from dsh-superagent-prototype (MIT) tests/store.spec.ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store, SCHEMA_VERSION, databasePath, DATABASE_FILE, lockOwner } from '../src/app/store.ts'
import { openReadOnly } from '../src/app/store-read.ts'
import { KV, record, family } from '../src/app/kv.ts'
import { Versions } from '../src/app/versions.ts'
import { MemoryRepositories, key, type Assignment, type Decision, type Repositories, type Thread, type Ticket } from '../src/core/index.ts'
import { harness, trigger } from './fixtures/engine.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-store-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it('refuses databases newer than this build and rolls back failed atomic work', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const store = new Store(path)
  expect(() => store.atomic(() => { store.set('a', 1); throw new Error('boom') })).toThrow('boom')
  expect(store.get('a')).toBeUndefined()
  store.set('schema', SCHEMA_VERSION + 1); store.close()
  expect(() => new Store(path)).toThrow('Unsupported')
})
it('finds triggers by thread', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.triggers.save({ id: 'a', source: 'chat', threads: [{ source: 'chat', id: 'room_1:msg_%_x' }], actor: { source: 'chat', id: 'u' }, human: true, at: '2', text: 'later', meta: {} })
  store.triggers.save({ id: 'b', source: 'chat', threads: [{ source: 'chat', id: 'room_1:msg_%_x' }, { source: 'tracker', id: '3' }], actor: { source: 'chat', id: 'u' }, human: true, at: '1', text: 'earlier', meta: {} })
  store.triggers.save({ id: 'c', source: 'chat', threads: [{ source: 'chat', id: 'room_1:msg_y_x' }], actor: { source: 'chat', id: 'u' }, human: true, at: '3', text: 'other', meta: {} })
  expect(store.read.threadTriggers('chat:room_1:msg_%_x').map(trigger => trigger.id)).toEqual(['b', 'a'])
  expect(store.read.threadTriggers('tracker:3').map(trigger => trigger.id)).toEqual(['b'])
  // Saving a Trigger again replaces the Threads it is found on.
  store.triggers.save({ ...store.triggers.get('b')!, threads: [{ source: 'tracker', id: '3' }] })
  expect(store.read.threadTriggers('chat:room_1:msg_%_x').map(trigger => trigger.id)).toEqual(['a'])
  expect(store.read.threadTriggers('tracker:3').map(trigger => trigger.id)).toEqual(['b'])
  expect(store.read.subscribedThreads()).toEqual([])
  store.close()
})
const ticket = (id: string, state: 'open' | 'ended', assignments: Pick<Assignment, 'state'>[], undelivered: string[] = []): Ticket => ({
  id, title: id, decisionId: '', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
  channels: [], assignments: assignments.map((item, index) => ({ id: `${id}-${index}`, createdAt: '', ...item })), inputs: [],
  ...state === 'ended' ? { ended: { at: '', by: 'executor' as const, reason: 'closed', outcome: 'closed' as const } } : {},
  undelivered, createdAt: '', updatedAt: '', origin: { triggerId: '', triggerIds: [] } })
const thread = (id: string, source: string, fields: Partial<Thread> = {}): Thread =>
  ({ key: `${source}:${id}`, ref: { source, id }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {}, ...fields })
const ids = (items: { id?: string; key?: string }[]) => items.map(item => item.id ?? item.key).sort()
it('reads the working sets alone, in SQLite as in memory, and follows each save', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  for (const repo of [store, new MemoryRepositories()] as Repositories[]) {
    repo.tickets.save(ticket('running', 'open', [{ state: 'running' }]))
    // A retry or a resume adds a pending Assignment after the ones that ended.
    repo.tickets.save(ticket('queued', 'open', [{ state: 'ended' }, { state: 'pending' }]))
    // An ended Ticket a person's message reached without resuming it.
    repo.tickets.save(ticket('waking', 'ended', [{ state: 'ended' }], ['input']))
    repo.tickets.save(ticket('done', 'ended', [{ state: 'ended' }]))
    repo.threads.save(thread('1', 'tracker', { pending: ['a'] }))
    repo.threads.save(thread('2', 'tracker', { subscriptions: ['running'], evaluating: { id: 'e', threadKey: 'tracker:2', triggerIds: ['b'], strength: 'explicit',
      actor: { source: 'tracker', id: 'alice' }, basis: { via: 'followup' }, policyVersion: '', startedAt: '', deadline: '' } }))
    repo.threads.save(thread('room:msg', 'chat', { subscriptions: ['done'] }))
    repo.threads.save(thread('3', 'tracker'))
    expect(ids(repo.tickets.open())).toEqual(['queued', 'running'])
    expect(ids(repo.tickets.active())).toEqual(['queued', 'running', 'waking'])
    expect(ids(repo.threads.active())).toEqual(['tracker:1', 'tracker:2'])
    repo.tickets.save(ticket('running', 'ended', [{ state: 'ended' }]))
    repo.threads.save(thread('1', 'tracker'))
    expect(ids(repo.tickets.open())).toEqual(['queued'])
    expect(ids(repo.tickets.active())).toEqual(['queued', 'waking'])
    expect(ids(repo.threads.active())).toEqual(['tracker:2'])
  }
  expect(ids(store.read.subscribedThreads())).toEqual(['chat:room:msg', 'tracker:2'])
  expect(ids(store.read.subscribedThreads('tracker'))).toEqual(['tracker:2'])
  store.close()
})
it('names a thread by its first human trigger', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const base = { source: 'tracker', threads: [{ source: 'tracker', id: '5' }], actor: { source: 'tracker', id: 'x' }, meta: {} }
  store.triggers.save({ ...base, id: 'ci', human: false, at: '1', text: 'Tracker PR #5 CI: {}' })
  store.triggers.save({ ...base, id: 'person', human: true, at: '2', text: 'please look' })
  expect(store.read.firstTrigger('tracker:5')?.id).toBe('ci')
  expect(store.read.firstTrigger('tracker:5', true)?.id).toBe('person')
  store.close()
})

it('counts triggers per Source and lists them newest first, optionally only the filtered ones', () => {
  const store = new Store(join(directory, 'db.sqlite'))
  const trigger = (id: string, source: string, at: string) => ({ id, source, threads: [{ source, id: 'x' }], actor: { source, id: 'a' }, human: true, at, text: id, meta: {} })
  store.triggers.save(trigger('old', 'chat', '2026-09-01T00:00:00Z'))
  store.triggers.save(trigger('kept', 'chat', '2026-09-23T00:00:00Z'))
  store.triggers.save(trigger('dropped', 'chat', '2026-09-23T01:00:00Z'))
  store.triggers.saveDisposition('dropped', { filtered: { code: 'chat_not_allowed' }, fanout: [], at: '' })
  store.triggers.save(trigger('gh', 'tracker', '2026-09-22T00:00:00Z'))
  expect(store.read.triggerStats('2026-09-22T12:00:00Z')).toEqual({ chat: { received: 2, filtered: 1, lastAt: '2026-09-23T01:00:00Z' }, tracker: { received: 0, filtered: 0, lastAt: '2026-09-22T00:00:00Z' } })
  expect(store.read.triggers({ source: 'chat' }, 0, 2)).toEqual({ items: [expect.objectContaining({ id: 'dropped' }), expect.objectContaining({ id: 'kept' })], more: true })
  expect(store.read.triggers({ filtered: true }).items.map(item => item.id)).toEqual(['dropped'])
  store.close()
})

it('sets and removes a Source\'s keys in a Thread\'s meta', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.threads.save({ key: 'tracker:5', ref: { source: 'tracker', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: { isPr: true, gone: true } })
  store.threads.patchMeta('tracker:5', { gone: undefined, title: 'Fix' })
  expect(store.threads.get('tracker:5')!.meta).toEqual({ isPr: true, title: 'Fix' })
  store.threads.patchMeta('tracker:6', { title: 'none' })
  expect(store.threads.get('tracker:6')).toBeUndefined()
  store.close()
})
it('spells every kv key in KV alone, so each record is named by its entry there', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const entries = Object.values(KV).flatMap(group => Object.values(group) as (string | { prefix: string })[])
  // Ignore single-word keys that collide with unrelated string literals.
  const keys = entries.map(entry => typeof entry === 'string' ? entry : entry.prefix).filter(name => /[-:]/.test(name))
  const modules = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter(path => /\.tsx?$/.test(path) && ![join('app', 'kv.ts')].includes(path))
  const spelled = modules.flatMap(path => {
    const text = readFileSync(join(src, path), 'utf8')
    return keys.filter(name => text.includes(`'${name}`) || text.includes(`\`${name}`)).map(name => `${path}: ${name}`)
  })
  expect(spelled).toEqual([])
})

it('runs what waits for a commit once the outermost transaction commits, and never what a rolled back one queued', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const ran: string[] = []
  store.atomic(() => {
    store.afterCommit(() => { ran.push('outer') })
    store.atomic(() => { store.afterCommit(() => { ran.push('inner') }) })
    expect(() => store.atomic(() => { store.afterCommit(() => { ran.push('rolled back') }); throw new Error('boom') })).toThrow('boom')
    // Nothing runs before the outermost transaction commits.
    expect(ran).toEqual([])
  })
  expect(ran).toEqual(['outer', 'inner'])
  expect(() => store.atomic(() => { store.afterCommit(() => { ran.push('failed') }); throw new Error('boom') })).toThrow('boom')
  store.afterCommit(() => { ran.push('outside') })
  expect(ran).toEqual(['outer', 'inner', 'outside'])
  store.close()
})

it('reports an action that fails after a commit, runs the others, and keeps what committed', () => {
  const reported: unknown[] = []
  const store = new Store(join(directory, 'orchestrator.sqlite'), error => { reported.push(error) })
  const ran: string[] = []
  const value = store.atomic(() => {
    store.set(KV.runtime.masterId, 'm')
    store.afterCommit(() => { throw new Error('cancel failed') })
    store.afterCommit(() => { ran.push('next') })
    return 'done'
  })
  expect(value).toBe('done')
  expect(ran).toEqual(['next'])
  expect(reported).toEqual([new Error('cancel failed')])
  expect(store.get(KV.runtime.masterId)).toBe('m')
  store.close()
})

it('closes a database it cannot open as this version\'s, so a later attempt can open it', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const store = new Store(path)
  store.set(KV.store.schema, SCHEMA_VERSION + 1)
  store.close()
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  try {
    expect(() => new Store(path)).toThrow('Unsupported database version')
    expect(close).toHaveBeenCalledOnce()
  } finally { close.mockRestore() }
})
it('keeps records as versions: the current one is the snapshot of the current revision, kept nowhere else', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const versions = new Versions<{ revision: number; value: string }>(store, record<number>('note-revision'), family<{ revision: number; value: string }, [revision: number]>('note-version:'))
  expect(versions.current()).toBeUndefined()
  versions.save(revision => ({ revision, value: 'a' }))
  versions.save(revision => ({ revision, value: 'b' }))
  expect(versions.current()).toEqual({ revision: 2, value: 'b' })
  expect(versions.list().map(version => [version.revision, version.value])).toEqual([[2, 'b'], [1, 'a']])
  expect([store.get(record<number>('note-revision')), store.keys('note').filter(name => name === 'note')]).toEqual([2, []])
  store.close()
})

it('lists in the same order in SQLite and in memory, and undoes a failed nested transaction alone in both', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const order = (items: { id?: string; key?: string }[]) => items.map(item => item.id ?? item.key)
  const decision = (id: string): Decision => ({ id, evalId: '', threadKey: 'tracker:1', triggerIds: [], policyVersion: '', at: id, kind: 'ignore', reason: [],
    strength: 'explicit' })
  const run = (repo: Repositories) => {
    repo.tickets.save(ticket('first', 'open', [{ state: 'running' }]))
    repo.tickets.save(ticket('second', 'ended', [{ state: 'ended' }]))
    repo.tickets.save(ticket('third', 'open', [{ state: 'pending' }]))
    // Saving a ticket again keeps its place.
    repo.tickets.save({ ...repo.tickets.get('first')!, title: 'again' })
    repo.threads.save(thread('1', 'tracker', { pending: ['a'] })); repo.threads.save(thread('2', 'tracker')); repo.threads.save(thread('3', 'tracker', { pending: ['b'] }))
    repo.decisions.save(decision('d2'))
    repo.decisions.save(decision('d1'))
    // A failed nested transaction undoes its own writes; the one around it goes on and keeps its own.
    repo.atomic(() => {
      repo.tickets.save(ticket('outer', 'open', []))
      expect(() => repo.atomic(() => { repo.tickets.save(ticket('inner', 'open', [])); throw new Error('boom') })).toThrow('boom')
    })
    return { tickets: order(repo.tickets.list()), open: order(repo.tickets.open()), active: order(repo.tickets.active()), threads: order(repo.threads.list()),
      activeThreads: order(repo.threads.active()), decisions: order(repo.decisions.byThread('tracker:1')) }
  }
  const memory = run(new MemoryRepositories())
  expect(memory).toEqual({ tickets: ['outer', 'third', 'second', 'first'], open: ['outer', 'third', 'first'], active: ['third', 'first'],
    threads: ['tracker:1', 'tracker:2', 'tracker:3'], activeThreads: ['tracker:1', 'tracker:3'], decisions: ['d2', 'd1'] })
  expect(run(store)).toEqual(memory)
  store.close()
})

it('creates the state directory for its owner alone, and the database readable by its owner alone', () => {
  const path = join(directory, 'state', DATABASE_FILE)
  new Store(path).close()
  expect([statSync(dirname(path)).mode & 0o777, statSync(path).mode & 0o777]).toEqual([0o700, 0o600])
})

it('reads `%` and `_` in a key prefix and a search query as written, not as patterns', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  for (const name of ['a%b', 'axb', 'a_c', 'abc']) store.set(name, 1)
  expect([store.keys('a%').sort(), store.keys('a_').sort()]).toEqual([['a%b'], ['a_c']])
  const said = (id: string, text: string) => ({ id, source: 'chat', threads: [{ source: 'chat', id: 'room_1:msg_1' }], actor: { source: 'chat', id: 'u' },
    human: true, at: '2026-10-01T00:00:00.000Z', text, meta: {} })
  for (const [id, text] of [['p', 'grew 50% today'], ['q', 'grew 500 today'], ['r', 'see a_b'], ['s', 'see axb']]) store.triggers.save(said(id!, text!))
  expect([store.read.search('50%').map(item => item.id), store.read.search('a_b').map(item => item.id)]).toEqual([['p'], ['r']])
  store.close()
})

function scenario(repo: Repositories) {
  const h = harness({}, { repo })
  h.engine.receive(trigger('1'))
  const first = h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'routed' })
  const again = h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'routed' })
  h.settle()
  return { first, again, duplicate: h.engine.receive(trigger('1')), tickets: repo.tickets.list(), threads: repo.threads.list(), decisions: repo.decisions.byThread('chat:t1') }
}
it('gives the Engine the same results as the in-memory repositories, keeps them across a reopen, and refuses a second writer', () => {
  const memory = scenario(new MemoryRepositories())
  expect(memory.tickets.length).toBe(1)
  expect(memory.again).toEqual(memory.first)
  expect(memory.duplicate).toBe('duplicate')
  const store = new Store(databasePath(directory))
  expect(scenario(store)).toEqual(memory)
  expect(() => new Store(databasePath(directory))).toThrow('Another superagent-claude process')
  store.close()
  const reopened = new Store(databasePath(directory))
  expect({ tickets: reopened.tickets.list(), threads: reopened.threads.list() }).toEqual({ tickets: memory.tickets, threads: memory.threads })
  expect(reopened.tickets.get(memory.tickets[0]!.id)!.assignments).toEqual(memory.tickets[0]!.assignments)
  reopened.close()
})
it('takes over a lock whose owner process has exited', () => {
  const path = databasePath(directory)
  mkdirSync(directory, { recursive: true })
  const gone = spawnSync(process.execPath, ['-e', '']).pid!
  mkdirSync(path + '.lock')
  writeFileSync(path + '.owner', String(gone))
  const store = new Store(path)
  expect(readFileSync(path + '.owner', 'utf8')).toBe(`${process.pid} ${hostname()}`)
  store.close()
  expect(existsSync(path + '.owner')).toBe(false)
})
it('refuses a fresh lock recorded on another host even when that pid is not running here', () => {
  const path = databasePath(directory)
  mkdirSync(directory, { recursive: true })
  const gone = spawnSync(process.execPath, ['-e', '']).pid!
  mkdirSync(path + '.lock')
  try {
    writeFileSync(path + '.owner', `${gone} other-host`)
    expect(() => new Store(path)).toThrow('Another superagent-claude process')
  } finally {
    rmSync(path + '.lock', { recursive: true, force: true })
  }
})
it('reads the lock owner with and without a host', () => {
  const path = databasePath(directory)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path + '.owner', '123 pod-a')
  expect(lockOwner(path)).toEqual({ pid: 123, host: 'pod-a' })
  writeFileSync(path + '.owner', '123')
  expect(lockOwner(path)).toEqual({ pid: 123 })
  writeFileSync(path + '.owner', 'x')
  expect(lockOwner(path)).toBeUndefined()
})
it('refuses a fresh lock whose owner still runs or is unknown', () => {
  const path = databasePath(directory)
  mkdirSync(directory, { recursive: true })
  mkdirSync(path + '.lock')
  try {
    writeFileSync(path + '.owner', String(process.pid))
    expect(() => new Store(path)).toThrow('Another superagent-claude process')
    rmSync(path + '.owner')
    expect(() => new Store(path)).toThrow('Another superagent-claude process')
  } finally {
    rmSync(path + '.lock', { recursive: true, force: true })
  }
})
it('reads through a read-only view while the writer runs, and refuses every write through it', () => {
  const path = databasePath(directory)
  const writer = new Store(path)
  writer.triggers.save(trigger('a'))
  const reader = openReadOnly(path)
  expect(reader.read.recentTriggers().map(item => item.id)).toEqual(['a'])
  expect(reader.get(KV.store.schema)).toBe(SCHEMA_VERSION)
  expect(() => reader.db.exec("INSERT INTO kv VALUES ('x','1')")).toThrow(/readonly/i)
  writer.triggers.save(trigger('b'))
  expect(reader.read.recentTriggers().map(item => item.id)).toEqual(['b', 'a'])
  reader.close(); writer.close()
  const again = openReadOnly(path)
  expect(again.read.recentTriggers().map(item => item.id)).toEqual(['b', 'a'])
  again.close()
})
it('waits on a busy database instead of failing at once (busy timeout)', () => {
  const path = databasePath(directory)
  const store = new Store(path)
  expect(Object.values(store.db.prepare('PRAGMA busy_timeout').get()!)[0]).toBe(5000)
  store.close()
  const reader = openReadOnly(path)
  expect(Object.values(reader.db.prepare('PRAGMA busy_timeout').get()!)[0]).toBe(5000)
  reader.close()
})
