// Ported from dsh-superagent-prototype (MIT) tests/passes.spec.ts
/**
 * Pass scheduling, coalescing, and runtime health reporting.
 * Changes from the reference: the trigger fixture uses the `chat` source; the interval timer and clock are injected through `PassesHost`; a case checks the 2-second tick and the injected clock; the stop-refusal case is renamed for superagent-claude.
 */
import { expect, it, vi } from 'vitest'
import { Passes, type PassesHost } from '../src/app/passes.ts'
import type { Trigger } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'

function passes(closing = () => false, extra: Partial<Pick<PassesHost, 'timers' | 'now'>> = {}) {
  const health = new HealthBoard().claim('runtime', { state: 'starting', detail: '' })
  const engine = { receive: vi.fn(() => 'stored' as const), evaluateDue: vi.fn() }
  const effects = { kick: vi.fn(), idle: vi.fn(async () => {}) }
  const value = new Passes({ engine, effects, health, lifetime: new AbortController().signal, configured: () => true, closing, ...extra })
  return { passes: value, engine, effects, health }
}
const trigger = { id: 't1', source: 'chat', threads: [{ source: 'chat', id: 'room_1:msg_1' }], actor: { source: 'chat', id: 'user_a' }, human: true,
  at: '2026-10-01T00:00:00.000Z', text: 'hi', meta: {} } as Trigger

it('reports a failed pass as an error of the runtime, which the next pass that succeeds clears', async () => {
  const h = passes()
  h.engine.evaluateDue.mockImplementationOnce(() => { throw new Error('database is locked') })
  h.passes.request()
  await h.passes.idle()
  expect(h.health.get()).toMatchObject({ state: 'error', detail: 'A pass failed: Error: database is locked' })
  h.passes.request()
  await h.passes.idle()
  expect(h.health.get()).toMatchObject({ state: 'ready', detail: 'Orchestrator is ready' })
})

it('runs the passes asked for during a pass as one pass after it', async () => {
  const h = passes()
  await Promise.all([h.passes.pump(), h.passes.pump(), h.passes.pump(), h.passes.pump()])
  expect([h.engine.evaluateDue.mock.calls.length, h.effects.kick.mock.calls.length]).toEqual([2, 2])
  await h.passes.pump()
  expect(h.engine.evaluateDue).toHaveBeenCalledTimes(3)
})

it('refuses a Trigger while superagent-claude stops, before the Engine stores anything, and starts a pass for one it stored', async () => {
  let closing = true
  const h = passes(() => closing)
  expect(() => h.passes.receive(trigger)).toThrow('Orchestrator is stopping')
  expect(h.engine.receive).not.toHaveBeenCalled()
  closing = false
  expect(h.passes.receive(trigger)).toBe('stored')
  await h.passes.idle()
  expect(h.engine.evaluateDue).toHaveBeenCalledOnce()
})

it('starts no timer once stopped, as a start-up that ends after a stop asks', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    const h = passes()
    await h.passes.stop()
    h.passes.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.engine.evaluateDue).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})

it('runs a pass on every tick of an injected 2-second timer, stamps health with the injected clock, and clears the timer on stop', async () => {
  let tick = () => {}
  const timers = { setInterval: vi.fn((run: () => void) => { tick = run; return 'handle' }), clearInterval: vi.fn() }
  const h = passes(() => false, { timers, now: () => Date.parse('2026-10-01T00:00:00Z') })
  h.passes.start()
  expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), 2000)
  tick(); await h.passes.idle()
  expect(h.engine.evaluateDue).toHaveBeenCalledOnce()
  h.engine.evaluateDue.mockImplementationOnce(() => { throw new Error('database is locked') })
  tick(); await h.passes.idle()
  expect(h.health.get()).toMatchObject({ state: 'error', at: '2026-10-01T00:00:00.000Z' })
  await h.passes.stop()
  expect(timers.clearInterval).toHaveBeenCalledWith('handle')
})
