import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/store/memory-store.ts'
import type { Task } from '../src/store/types.ts'

const task = (id: string, title = id): Task => ({
  id,
  title,
  status: 'todo',
  dueDate: null,
  ownerId: 'alice',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

test('insert, get, replace and remove', () => {
  const store = createMemoryStore()
  store.insert(task('task-1'))
  assert.equal(store.get('task-1')?.title, 'task-1')
  store.replace(task('task-1', 'renamed'))
  assert.equal(store.get('task-1')?.title, 'renamed')
  assert.equal(store.remove('task-1'), true)
  assert.equal(store.get('task-1'), undefined)
  assert.equal(store.remove('task-1'), false)
})

test('all returns copies in insertion order', () => {
  const store = createMemoryStore()
  store.insert(task('task-2'))
  store.insert(task('task-1'))
  const listed = store.all()
  assert.deepEqual(listed.map((t) => t.id), ['task-2', 'task-1'])
  listed[0]!.title = 'changed'
  assert.equal(store.get('task-2')?.title, 'task-2')
})

test('count reports the number of stored tasks', () => {
  const store = createMemoryStore()
  assert.equal(store.count(), 0)
  store.insert(task('task-1'))
  store.insert(task('task-2'))
  assert.equal(store.count(), 2)
})

test('lastIndex is 2 for three tasks', () => {
  const store = createMemoryStore()
  store.insert(task('task-1'))
  store.insert(task('task-2'))
  store.insert(task('task-3'))
  assert.equal(store.lastIndex(), 2)
})
