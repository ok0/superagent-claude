import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayKey, isDueToday, isOverdue } from '../src/services/due.ts'
import { now } from '../src/config/clock.ts'

test('dayKey formats the local calendar date', () => {
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05')
})

test('isOverdue is true for an open task before today', () => {
  assert.equal(isOverdue({ dueDate: '2026-01-04', status: 'todo' }, new Date(2026, 0, 5, 12)), true)
})

test('isOverdue is false for a done task', () => {
  assert.equal(isOverdue({ dueDate: '2026-01-04', status: 'done' }, new Date(2026, 0, 5, 12)), false)
})

test('isOverdue is false when there is no due date', () => {
  assert.equal(isOverdue({ dueDate: null, status: 'todo' }, new Date(2026, 0, 5, 12)), false)
})

test('isDueToday matches only the current day', () => {
  const at = new Date(2026, 0, 5, 12)
  assert.equal(isDueToday({ dueDate: '2026-01-05' }, at), true)
  assert.equal(isDueToday({ dueDate: '2026-01-06' }, at), false)
})

test('a task due today counts as due today', () => {
  assert.equal(isDueToday({ dueDate: dayKey(now()) }), true)
})
