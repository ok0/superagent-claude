/**
 * The acknowledgement an accept carries is held on the ticket until its Assignment starts, so a ticket that waits for a slot posts none, and one stopped before it launched never posts it.
 */
import { expect, it } from 'vitest'
import { key } from '../src/core/index.ts'
import { accepted, harness, trigger } from './fixtures/engine.ts'
import { gates, workerHarness } from './fixtures/executor.ts'
import { waitUntil } from './fixtures/async.ts'

it('holds the accept acknowledgement of a ticket waiting for a slot until it launches', async () => {
  const g = gates()
  let a = ''
  const w = workerHarness({ max: 1, script: ({ spec }) => (spec.key === `worker-${a}` ? { hold: g.get('a') } : {}) })
  try {
    a = accepted(w, '1', 't1').ticketId!
    await waitUntil(() => w.runtime.opened.length === 1)
    w.tick(1)
    const b = accepted(w, '2', 't2').ticketId!
    await w.effects.idle('launch')
    expect(w.outbox.filter(m => m.kind === 'acknowledgement' && m.ticketId === b)).toHaveLength(0)
    expect(w.ticket(b).acknowledgement).toEqual({ triggerId: '2', text: 'ok' })
    g.open('a')
    await waitUntil(() => w.runtime.opened.length === 2)
    const acks = w.outbox.filter(m => m.kind === 'acknowledgement' && m.ticketId === b)
    expect(acks).toHaveLength(1)
    expect(acks[0]!.id).toBe(key('ack', '2'))
    expect(w.ticket(b).acknowledgement).toBeUndefined()
    expect(w.outbox.filter(m => m.ticketId === b)).toHaveLength(1)
  } finally {
    await w.close()
  }
})

it('never posts the acknowledgement of a ticket stopped before it launched', () => {
  const h = harness()
  h.engine.receive(trigger('1'))
  h.pump()
  const id = h.decide(h.requests.at(-1)!, {
    kind: 'accept',
    title: 'Fix',
    scope: 'small',
    reason: 'requested',
    acknowledgement: 'ok',
  }).ticketId!
  h.settle({ launch: false })
  expect(h.outbox.some(m => m.id === key('ack', '1'))).toBe(false)
  h.engine.stopTicket(id)
  h.settle()
  expect(h.outbox.some(m => m.id === key('ack', '1'))).toBe(false)
})
