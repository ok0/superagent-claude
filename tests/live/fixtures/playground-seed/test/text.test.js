import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify, truncate, wordCount } from '../src/text.js'

test('slugify turns words into a url slug', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('Crème brûlée'), 'creme-brulee')
})

test('truncate keeps short text', () => {
  assert.equal(truncate('hi', 5), 'hi')
})

test('truncate shortens long text with an ellipsis', () => {
  assert.equal(truncate('hello world', 6), 'hello…')
})

test('wordCount counts words', () => {
  assert.equal(wordCount('one two  three'), 3)
  assert.equal(wordCount('   '), 0)
})
