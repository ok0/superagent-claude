import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ValidationError } from '../src/services/errors.ts'
import { validateNewTask } from '../src/services/validation.ts'

test('a valid task input is accepted', () => {
  const input = validateNewTask({ title: 'write docs', status: 'doing', dueDate: '2026-02-28' })
  assert.equal(input.title, 'write docs')
  assert.equal(input.status, 'doing')
  assert.equal(input.dueDate, '2026-02-28')
})

test('an empty title throws ValidationError', () => {
  assert.throws(() => validateNewTask({ title: '' }), ValidationError)
})

test('a title of 201 characters throws ValidationError', () => {
  assert.throws(() => validateNewTask({ title: 'x'.repeat(201) }), ValidationError)
})

test('a bad status throws ValidationError', () => {
  assert.throws(() => validateNewTask({ title: 'a', status: 'later' }), ValidationError)
})

test('an impossible calendar date throws ValidationError', () => {
  assert.throws(() => validateNewTask({ title: 'a', dueDate: '2026-02-30' }), ValidationError)
})

test('an unknown key throws ValidationError', () => {
  assert.throws(() => validateNewTask({ title: 'a', extra: true }), ValidationError)
})
