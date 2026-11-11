import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTH_A, AUTH_B, startApi } from './serve.ts'

type Auth = Record<string, string> | null

async function json(
  base: string,
  method: string,
  path: string,
  auth: Auth,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const headers: Record<string, string> = { ...(auth ?? {}) }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>) }
}

async function createTask(base: string): Promise<string> {
  const created = await json(base, 'POST', '/tasks', AUTH_A, { title: 'Write report', dueDate: '2026-03-01' })
  assert.equal(created.status, 201)
  return created.body!.id as string
}

test('PATCH changes only the given status', async () => {
  const api = await startApi()
  try {
    const id = await createTask(api.base)
    const res = await json(api.base, 'PATCH', '/tasks/' + id, AUTH_A, { status: 'done' })
    assert.equal(res.status, 200)
    assert.equal(res.body!.id, id)
    assert.equal(res.body!.status, 'done')
    assert.equal(res.body!.title, 'Write report')
    assert.equal(res.body!.dueDate, '2026-03-01')
    const got = await json(api.base, 'GET', '/tasks/' + id, AUTH_A)
    assert.equal(got.body!.status, 'done')
  } finally {
    await api.stop()
  }
})

test('PATCH changes only the given title', async () => {
  const api = await startApi()
  try {
    const id = await createTask(api.base)
    const res = await json(api.base, 'PATCH', '/tasks/' + id, AUTH_A, { title: 'Final report' })
    assert.equal(res.status, 200)
    assert.equal(res.body!.title, 'Final report')
    assert.equal(res.body!.status, 'todo')
    assert.equal(res.body!.dueDate, '2026-03-01')
  } finally {
    await api.stop()
  }
})

test('PATCH clears the due date', async () => {
  const api = await startApi()
  try {
    const id = await createTask(api.base)
    const res = await json(api.base, 'PATCH', '/tasks/' + id, AUTH_A, { dueDate: null })
    assert.equal(res.status, 200)
    assert.equal(res.body!.dueDate, null)
  } finally {
    await api.stop()
  }
})

test('PATCH rejects invalid fields', async () => {
  const api = await startApi()
  try {
    const id = await createTask(api.base)
    const invalid = [{ status: 'nope' }, { title: '' }, { dueDate: '2026-02-30' }]
    for (const body of invalid) {
      const res = await json(api.base, 'PATCH', '/tasks/' + id, AUTH_A, body)
      assert.equal(res.status, 400)
    }
    const got = await json(api.base, 'GET', '/tasks/' + id, AUTH_A)
    assert.equal(got.body!.title, 'Write report')
    assert.equal(got.body!.status, 'todo')
    assert.equal(got.body!.dueDate, '2026-03-01')
  } finally {
    await api.stop()
  }
})

test('PATCH of an unknown task is 404', async () => {
  const api = await startApi()
  try {
    const res = await json(api.base, 'PATCH', '/tasks/task-999', AUTH_A, { status: 'done' })
    assert.equal(res.status, 404)
  } finally {
    await api.stop()
  }
})

test('PATCH by someone else is 403', async () => {
  const api = await startApi()
  try {
    const id = await createTask(api.base)
    const res = await json(api.base, 'PATCH', '/tasks/' + id, AUTH_B, { status: 'done' })
    assert.equal(res.status, 403)
    const got = await json(api.base, 'GET', '/tasks/' + id, AUTH_A)
    assert.equal(got.body!.status, 'todo')
  } finally {
    await api.stop()
  }
})

test('PATCH without a token is 401', async () => {
  const api = await startApi()
  try {
    const id = await createTask(api.base)
    const res = await json(api.base, 'PATCH', '/tasks/' + id, null, { status: 'done' })
    assert.equal(res.status, 401)
  } finally {
    await api.stop()
  }
})
