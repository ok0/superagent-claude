import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTaskService } from '../src/services/task-service.ts'
import { createMemoryStore } from '../src/store/memory-store.ts'

test('paging with limit 2 reaches all five tasks', () => {
  const service = createTaskService({ store: createMemoryStore() })
  for (let i = 1; i <= 5; i++) service.create({ title: "Task " + i }, "u1")
  let start = 0
  let total = 0
  for (let n = 0; n < 10; n++) {
    const page = service.list({ start, limit: 2 })
    total += page.items.length
    if (page.next === null) break
    start = page.next
  }
  assert.equal(total, 5)
})
