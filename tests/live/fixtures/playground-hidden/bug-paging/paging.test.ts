import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTH_A, startApi } from './serve.ts'

interface Page {
  items: { id: string }[]
  nextCursor: string | null
}

async function create(base: string, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 1; i <= n; i++) {
    const res = await fetch(base + '/tasks', {
      method: 'POST',
      headers: { ...AUTH_A, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Task ' + i }),
    })
    assert.equal(res.status, 201)
    const task = (await res.json()) as { id: string }
    ids.push(task.id)
  }
  return ids
}

async function pages(base: string, limit: number): Promise<{ ids: string[]; sizes: number[] }> {
  const ids: string[] = []
  const sizes: number[] = []
  let cursor: string | null = null
  for (let n = 0; n < 50; n++) {
    const query = 'limit=' + limit + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor))
    const res = await fetch(base + '/tasks?' + query, { headers: AUTH_A })
    assert.equal(res.status, 200)
    const page = (await res.json()) as Page
    sizes.push(page.items.length)
    for (const item of page.items) ids.push(item.id)
    if (page.nextCursor === null) return { ids, sizes }
    cursor = page.nextCursor
  }
  assert.fail('paging did not finish in 50 pages')
}

test('paging with limit 2 lists each of five tasks once, in order', async () => {
  const api = await startApi()
  try {
    const ids = await create(api.base, 5)
    const got = await pages(api.base, 2)
    assert.deepEqual(got.ids, ids)
    assert.deepEqual(got.sizes, [2, 2, 1])
  } finally {
    await api.stop()
  }
})

test('the page before the last one still has a next cursor', async () => {
  const api = await startApi()
  try {
    await create(api.base, 4)
    const got = await pages(api.base, 2)
    assert.deepEqual(got.sizes, [2, 2])
  } finally {
    await api.stop()
  }
})

test('one page lists every task when the limit is larger', async () => {
  const api = await startApi()
  try {
    await create(api.base, 3)
    const res = await fetch(api.base + '/tasks?limit=10', { headers: AUTH_A })
    assert.equal(res.status, 200)
    const page = (await res.json()) as Page
    assert.equal(page.items.length, 3)
    assert.equal(page.nextCursor, null)
  } finally {
    await api.stop()
  }
})

test('a single task is listed by default', async () => {
  const api = await startApi()
  try {
    await create(api.base, 1)
    const res = await fetch(api.base + '/tasks', { headers: AUTH_A })
    assert.equal(res.status, 200)
    const page = (await res.json()) as Page
    assert.equal(page.items.length, 1)
    assert.equal(page.nextCursor, null)
  } finally {
    await api.stop()
  }
})
