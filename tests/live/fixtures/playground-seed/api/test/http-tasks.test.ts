import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTH_A, AUTH_B, startServer } from './helpers.ts'

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = await startServer()
  try {
    await run(server.base)
  } finally {
    await server.close()
  }
}

const createTask = (base: string, body: unknown, headers: Record<string, string> = AUTH_A) =>
  fetch(base + '/tasks', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('a request without a token returns 401', () =>
  withServer(async (base) => {
    const res = await fetch(base + '/tasks', { method: 'POST' })
    assert.equal(res.status, 401)
    await res.text()
  }))

test('POST /tasks creates a task and echoes it', () =>
  withServer(async (base) => {
    const res = await createTask(base, { title: 'write docs' })
    assert.equal(res.status, 201)
    const body = (await res.json()) as { title: string; status: string }
    assert.equal(body.title, 'write docs')
    assert.equal(body.status, 'todo')
  }))

test('POST /tasks with an invalid body returns 400', () =>
  withServer(async (base) => {
    const res = await createTask(base, { title: '' })
    assert.equal(res.status, 400)
    await res.text()
  }))

test('GET /tasks/:id returns 200 for a known task and 404 for an unknown one', () =>
  withServer(async (base) => {
    const created = await createTask(base, { title: 'read' })
    await created.text()
    const found = await fetch(base + '/tasks/task-1', { headers: AUTH_A })
    assert.equal(found.status, 200)
    assert.equal(((await found.json()) as { id: string }).id, 'task-1')
    const missing = await fetch(base + '/tasks/task-404', { headers: AUTH_A })
    assert.equal(missing.status, 404)
    await missing.text()
  }))

test('DELETE by a non-owner returns 403 and by the owner returns 204', () =>
  withServer(async (base) => {
    const created = await createTask(base, { title: 'delete me' })
    await created.text()
    const denied = await fetch(base + '/tasks/task-1', { method: 'DELETE', headers: AUTH_B })
    assert.equal(denied.status, 403)
    await denied.text()
    const removed = await fetch(base + '/tasks/task-1', { method: 'DELETE', headers: AUTH_A })
    assert.equal(removed.status, 204)
    await removed.text()
  }))

test('GET /tasks pages with a cursor', () =>
  withServer(async (base) => {
    for (const title of ['one', 'two', 'three']) {
      const created = await createTask(base, { title })
      await created.text()
    }
    const first = await fetch(base + '/tasks?limit=1', { headers: AUTH_A })
    assert.equal(first.status, 200)
    const firstBody = (await first.json()) as { items: { id: string }[]; nextCursor: string | null }
    assert.deepEqual(firstBody.items.map((t) => t.id), ['task-1'])
    assert.notEqual(firstBody.nextCursor, null)
    const second = await fetch(
      base + '/tasks?limit=1&cursor=' + encodeURIComponent(firstBody.nextCursor ?? ''),
      { headers: AUTH_A },
    )
    assert.equal(second.status, 200)
    const secondBody = (await second.json()) as { items: { id: string }[] }
    assert.deepEqual(secondBody.items.map((t) => t.id), ['task-2'])
  }))
