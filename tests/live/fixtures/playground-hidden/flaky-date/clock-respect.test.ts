import assert from 'node:assert/strict'
import { test } from 'node:test'
import { now } from '../../src/config/clock.ts'
import { dayKey, isDueToday } from '../../src/services/due.ts'
const pinned = process.env.FAKE_NOW
test('the clock follows FAKE_NOW', () => { assert.ok(pinned, 'FAKE_NOW is set'); assert.equal(now().toISOString(), new Date(pinned).toISOString()) })
test('isDueToday without a date uses the pinned day', () => { assert.ok(pinned); assert.equal(isDueToday({ dueDate: dayKey(new Date(pinned)) }), true) })
