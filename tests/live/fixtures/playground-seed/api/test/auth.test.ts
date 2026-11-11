import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authenticate } from '../src/auth/middleware.ts'
import { canModify } from '../src/auth/roles.ts'
import { bearerToken } from '../src/auth/tokens.ts'
import { UnauthorizedError } from '../src/services/errors.ts'

const tokens = new Map([
  ['tok-a', 'alice'],
  ['tok-b', 'bob'],
])

test('bearerToken reads the token and accepts any scheme case', () => {
  assert.equal(bearerToken('Bearer tok-a'), 'tok-a')
  assert.equal(bearerToken('bearer tok-a'), 'tok-a')
  assert.equal(bearerToken(undefined), null)
  assert.equal(bearerToken('Basic dXNlcjpwYXNz'), null)
})

test('authenticate returns the user for a known token', () => {
  assert.equal(authenticate('Bearer tok-a', tokens), 'alice')
})

test('authenticate rejects an unknown token', () => {
  assert.throws(() => authenticate('Bearer nope', tokens), UnauthorizedError)
})

test('authenticate rejects a missing header', () => {
  assert.throws(() => authenticate(undefined, tokens), UnauthorizedError)
})

test('canModify allows only the owner', () => {
  assert.equal(canModify({ ownerId: 'alice' }, 'alice'), true)
  assert.equal(canModify({ ownerId: 'alice' }, 'bob'), false)
})
