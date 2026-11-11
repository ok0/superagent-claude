import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers.ts'

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = await startServer()
  try {
    await run(server.base)
  } finally {
    await server.close()
  }
}

test('GET /health returns ok without auth', () =>
  withServer(async (base) => {
    const res = await fetch(base + '/health')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'ok' })
  }))

test('an unknown path returns 404', () =>
  withServer(async (base) => {
    const res = await fetch(base + '/nope')
    assert.equal(res.status, 404)
    await res.text()
  }))

test('DELETE /health returns 405', () =>
  withServer(async (base) => {
    const res = await fetch(base + '/health', { method: 'DELETE' })
    assert.equal(res.status, 405)
    await res.text()
  }))
