import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeCursor, encodeCursor } from '../src/http/cursor.ts'
import { ValidationError } from '../src/services/errors.ts'

test('encode and decode round trip', () => {
  assert.equal(decodeCursor(encodeCursor(0)), 0)
  assert.equal(decodeCursor(encodeCursor(7)), 7)
})

test('a missing cursor decodes to 0', () => {
  assert.equal(decodeCursor(null), 0)
})

test('a garbage cursor throws ValidationError', () => {
  assert.throws(() => decodeCursor('garbage'), ValidationError)
})
