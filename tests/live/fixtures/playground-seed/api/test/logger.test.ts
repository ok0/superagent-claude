import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatLine } from '../src/log/format.ts'
import { LineBuffer } from '../src/log/line-buffer.ts'
import { createLogger } from '../src/log/logger.ts'

test('the level filter drops debug lines at info', () => {
  const lines: string[] = []
  const logger = createLogger({ level: 'info', sink: (line) => lines.push(line), now: () => new Date(0) })
  logger.debug('hidden')
  assert.equal(lines.length, 0)
  logger.info('shown')
  assert.equal(lines.length, 1)
})

test('formatLine emits JSON with the given time', () => {
  const at = new Date('2026-01-05T10:00:00.000Z')
  const parsed = JSON.parse(formatLine('info', 'hello', { n: 1 }, at)) as Record<string, unknown>
  assert.equal(parsed['time'], at.toISOString())
  assert.equal(parsed['level'], 'info')
  assert.equal(parsed['msg'], 'hello')
  assert.equal(parsed['n'], 1)
})

test('LineBuffer flushes in order with a small capacity', () => {
  const out: string[] = []
  const buffer = new LineBuffer((chunk) => out.push(chunk), 16)
  buffer.write('aaaaaaa')
  buffer.write('bbbbbbb')
  buffer.write('ccccccc')
  buffer.flush()
  assert.equal(out.join(''), 'aaaaaaa\nbbbbbbb\nccccccc\n')
})
