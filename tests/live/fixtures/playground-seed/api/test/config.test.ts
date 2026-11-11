import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readTokens } from '../src/config/env.ts'
import { loadConfig } from '../src/config/index.ts'

test('defaults are applied when nothing is set', () => {
  const config = loadConfig({})
  assert.equal(config.port, 3000)
  assert.equal(config.pageSize, 20)
  assert.equal(config.maxPageSize, 100)
  assert.equal(config.logLevel, 'info')
  assert.equal(config.tokens.size, 0)
})

test('a non-integer PAGE_SIZE throws', () => {
  assert.throws(() => loadConfig({ PAGE_SIZE: 'abc' }))
})

test('API_TOKENS entries are read as token to user', () => {
  const tokens = readTokens('a:x,b:y')
  assert.equal(tokens.size, 2)
  assert.equal(tokens.get('x'), 'a')
  assert.equal(tokens.get('y'), 'b')
})

test('a malformed API_TOKENS entry throws', () => {
  assert.throws(() => readTokens('no-separator'))
})
