import { expect, it, vi } from 'vitest'
import type { Thread, Ticket } from '../src/core/index.ts'
import { POLL_HORIZON_MS, cursorAt, pause, polled, pollThreads } from '../src/sources/poll.ts'
import { ManualClock } from './fixtures/executor.ts'

const createdAt = '2026-09-01T00:00:00.000Z'
const day = 24 * 3600_000
const thread = (subscriptions: string[], extra: Partial<Thread> = {}): Thread => ({
  key: 'probe:1',
  ref: { source: 'probe', id: '1' },
  createdAt,
  subscriptions,
  correlated: [],
  pending: [],
  meta: {},
  ...extra,
})
const ticket = (ended?: { at: string }) => ({ ended }) as unknown as Ticket
const tickets = (values: Record<string, Ticket>) => ({ get: (id: string) => values[id] })

it('polls a thread with a live ticket, or one active within the horizon', () => {
  const now = Date.parse(createdAt) + day
  expect(polled({ tickets: tickets({ t_live: ticket() }) }, thread(['t_live']), now)).toBe(true)
  const later = Date.parse(createdAt) + POLL_HORIZON_MS + 1
  expect(polled({ tickets: tickets({}) }, thread([]), later)).toBe(false)
  const endedAt = new Date(later - day).toISOString()
  expect(polled({ tickets: tickets({ t_ended: ticket({ at: endedAt }) }) }, thread(['t_ended']), later)).toBe(true)
})
it('steps a cursor back five seconds', () => {
  expect(cursorAt('2026-09-23T00:00:10.000Z')).toBe('2026-09-23T00:00:05.000Z')
})
it('records and clears pollError per thread and stops when asked', async () => {
  const patch = vi.fn()
  const threads = [thread(['t_live'], { key: 'probe:1' }), thread(['t_live'], { key: 'probe:2' })]
  const ctx = { threads: { subscribed: () => threads, patch }, tickets: tickets({ t_live: ticket() }) }
  await pollThreads(
    ctx,
    'probe',
    () => false,
    async current => {
      if (current.key === 'probe:1') throw new Error('boom')
    },
  )
  expect(patch).toHaveBeenCalledWith('probe:1', { pollError: 'Error: boom' })
  expect(patch).toHaveBeenCalledWith('probe:2', { pollError: undefined })
  const polledKeys: string[] = []
  let stopped = false
  await pollThreads(
    ctx,
    'probe',
    () => stopped,
    async current => {
      polledKeys.push(current.key)
      stopped = true
    },
  )
  expect(polledKeys).toEqual(['probe:1'])
})
it('pause waits for the injected timer and ends early on abort', async () => {
  const clock = new ManualClock()
  const controller = new AbortController()
  let settled = false
  const first = pause(1000, controller.signal, clock).then(() => {
    settled = true
  })
  clock.advance(999)
  await Promise.resolve()
  expect(settled).toBe(false)
  clock.advance(1)
  await first
  expect(settled).toBe(true)
  const second = pause(1000, controller.signal, clock)
  controller.abort()
  await second
  expect(clock.pending).toBe(0)
})
