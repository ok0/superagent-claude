import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchRoute, type Route } from '../src/http/router.ts'

const routes: Route[] = [
  { method: 'GET', pattern: '/tasks/:id', handler: () => {} },
]

test('matchRoute extracts params for a matching route', () => {
  const match = matchRoute(routes, 'GET', '/tasks/abc')
  assert.ok(match !== null && 'route' in match)
  assert.deepEqual(match.params, { id: 'abc' })
})

test('matchRoute reports the allowed methods for the wrong method', () => {
  const match = matchRoute(routes, 'PUT', '/tasks/abc')
  assert.ok(match !== null && 'allowed' in match)
  assert.deepEqual(match.allowed, ['GET'])
})

test('matchRoute returns null for an unknown path', () => {
  assert.equal(matchRoute(routes, 'GET', '/nope'), null)
})
