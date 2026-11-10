import { describe, expect, it } from 'vitest'
import { harness, accepted, trigger, guest } from './fixtures/engine.ts'
import { refusalText } from '../src/core/replies.ts'
import type { Policy } from '../src/core/index.ts'

const gate: Policy['gate'] = (t, thread) => !t.human ? { admissible: false, reason: 'not human' }
  : t.actor.id === 'alice' && t.addressed ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: t.addressed } }
  : t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
  : t.actor.id === 'guest' ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
  : { admissible: false, reason: 'not a member' }
const refusing = () => harness({ gate, refuses: true })
const REASON = 'Booking a restaurant table is not something this repository covers. Try a booking site.'
const refusals = (h: ReturnType<typeof refusing>) => h.outbox.filter(m => m.id.startsWith('refusal:'))

describe('refusal replies', () => {
  it('an ignored explicit mention gets one refusal on its issue, also when it is decided again', () => {
    const h = refusing()
    h.engine.receive(trigger('1', { addressed: 'mention' })); h.pump()
    h.decide(h.requests[0]!, { kind: 'ignore', reason: REASON })
    expect(refusals(h)).toEqual([{ id: 'refusal:1', channel: trigger('1').channel, text: "I can't take this on here: Booking a restaurant table is not something this repository covers.", kind: 'reply' }])
    const text = refusals(h)[0]!.text
    expect(text.length).toBeLessThanOrEqual(200)
    expect(text).not.toMatch(/ticket|worker|hand back|trigger/i)
    h.engine.reevaluate('1'); h.pump()
    h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: REASON })
    expect(refusals(h)).toHaveLength(1)
  })

  it('a mention handed back from a running ticket and ignored gets one refusal in its thread', () => {
    const h = refusing()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { addressed: 'mention' })); h.settle()
    h.engine.handback(ticketId, '2', 'Asks for more than this change')
    h.pump()
    expect(h.requests.at(-1)!.triggers.map(t => t.id)).toEqual(['2'])
    h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'Booking a table is outside this repository.' })
    expect(refusals(h)).toEqual([expect.objectContaining({ id: 'refusal:2', channel: trigger('2').channel, text: "I can't take this on here: Booking a table is outside this repository." })])
  })

  it('nothing is posted for an inferred, bot, unlisted or unmentioned message, or for a reason code', () => {
    const h = refusing()
    const t = (n: string) => [{ source: 'chat', id: `t${n}` }]
    h.engine.receive(trigger('3', { actor: guest, addressed: 'mention', threads: t('3') })); h.pump()
    h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chatter' })
    h.engine.receive(trigger('4', { human: false, addressed: 'mention', threads: t('4') })); h.pump()
    h.engine.receive(trigger('5', { actor: { source: 'chat', id: 'mallory' }, addressed: 'mention', threads: t('5') })); h.pump()
    h.engine.receive(trigger('6', { threads: t('6') })); h.pump()
    h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: REASON })
    h.engine.receive(trigger('7', { addressed: 'mention', threads: t('7') })); h.pump()
    h.decide(h.requests.at(-1)!, { kind: 'stop', ticketId: 'missing', reason: 'stop' })
    h.engine.receive(trigger('8', { addressed: 'mention', threads: t('8') })); h.pump()
    h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: { code: 'observed', values: { text: 'Fix' } }, audit: { would_accept: true } })
    expect(refusals(h)).toEqual([])
    for (const n of ['3', '4', '5', '6', '7', '8']) {
      expect(h.repo.decisions.byThread(`chat:t${n}`).every(decision => decision.kind === 'ignore')).toBe(true)
    }
  })

  it('nothing is posted while the Policy does not allow refusals', () => {
    const h = harness({ gate })
    h.engine.receive(trigger('1', { addressed: 'mention' })); h.pump()
    h.decide(h.requests[0]!, { kind: 'ignore', reason: REASON })
    expect(refusals(h)).toEqual([])
  })
})

describe('refusalText', () => {
  it('keeps the first sentence of the reason behind the prefix', () => {
    expect(refusalText('Not a code change. Ask a person.')).toBe("I can't take this on here: Not a code change.")
  })

  it('falls back when the reason names internal terms', () => {
    expect(refusalText('This ticket is already done.')).toBe("I can't take this on here: it is outside what I can do.")
    expect(refusalText('Handed back by the worker.')).toBe("I can't take this on here: it is outside what I can do.")
  })

  it('falls back on a long hex id and on a blank reason', () => {
    expect(refusalText('See a1b2c3d4e5f6a7b8c9d0 for details.')).toBe("I can't take this on here: it is outside what I can do.")
    expect(refusalText('   ')).toBe("I can't take this on here: it is outside what I can do.")
  })

  it('keeps a Korean first sentence', () => {
    expect(refusalText('이 요청은 저장소 작업이 아닙니다. 다른 곳에 문의하세요.')).toBe("I can't take this on here: 이 요청은 저장소 작업이 아닙니다.")
  })

  it('caps the text at 200 characters with an ellipsis', () => {
    const text = refusalText('x'.repeat(300))
    expect(text).toHaveLength(200)
    expect(text.startsWith("I can't take this on here: ")).toBe(true)
    expect(text.endsWith('…')).toBe(true)
  })
})
