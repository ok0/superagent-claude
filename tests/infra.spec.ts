/** Infrastructure helpers: package root lookup, text utilities, and single-owner health entries. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { HealthBoard } from '../src/infra/health.ts'
import { packagePath } from '../src/infra/paths.ts'
import { escapeRegExp, fill, wordCount } from '../src/infra/text.ts'

it('finds the package root by its name', () => {
  expect(JSON.parse(readFileSync(packagePath('package.json'), 'utf8')).name).toBe('superagent-claude')
})

it('keeps word counting and templates, without the IM limit or a second sameName', async () => {
  expect(Object.keys(await import('../src/infra/text.ts')).sort()).toEqual(['NOTE_WORDS', 'escapeRegExp', 'fill', 'wordCount'])
  expect(wordCount('Fix the build, please.')).toBe(4)
  expect(fill('{a}-{b}', { a: 'x' })).toBe('x-')
  expect(escapeRegExp('a.b*')).toBe('a\\.b\\*')
})

it('gives each health entry one owner until it is released', () => {
  const board = new HealthBoard()
  const entry = board.claim('a', { state: 'ready', detail: '' })
  expect(board.all.a).toEqual({ state: 'ready', detail: '' })
  expect(() => board.claim('a')).toThrow('The health entry a is reported by another part')
  entry.release()
  entry.set({ state: 'error', detail: 'late' })
  expect(board.all.a).toBeUndefined()
  expect(() => board.claim('a')).not.toThrow()
})
