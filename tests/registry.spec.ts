// Ported from dsh-superagent-prototype (MIT) tests/registry.spec.ts
/** Source registry cases for kinds without bundled plugins. Changes from the reference: cases that depend on the bundled Source kinds are not ported; the kind has no display fields; configs come from a reader; scope, channel and find cases are added. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

const probe: SourceKind<{ interval: number }> = {
  kind: 'probe', schema: z.object({ interval: z.number().int().min(1).default(5) }).strict(),
}
const message = (source: string): OutboundMessage => ({ id: 'r1', channel: { source, thread: 'probe:1', address: { room: 'r' } }, text: 'hi', kind: 'reply' })

describe('Source registry', () => {
  it('validates submitted configs with the kind schema and refuses kinds that are not installed', () => {
    const sources = new SourceRegistry(() => ({}))
    sources.register(probe)
    expect(sources.validate('probe', {})).toEqual({ interval: 5 })
    expect(() => sources.validate('probe', { interval: 0 })).toThrow()
    expect(() => sources.validate('missing', {})).toThrow('not installed')
  })
  it('sends and reads a kind\'s Threads through its own channel and context, and nothing for a kind without them', async () => {
    const sources = new SourceRegistry(() => ({ probe: { interval: 7 } }))
    const sent: OutboundMessage[] = []
    const read: unknown[] = []
    sources.register({ ...probe,
      channel: { send: async message => { sent.push(message); return 'sent' } },
      threadContext: { messageId: trigger => String(trigger.meta.id), read: async (trigger, part, cursor, config) => {
        read.push([trigger.id, part, cursor, config.interval])
        return { messages: [{ id: 'm1', from: 'u', at: '1', text: '' }], body: { page: cursor ?? 'first' } }
      } } })
    expect(await sources.send(message('probe'))).toBe('sent')
    expect(sent).toEqual([message('probe')])
    expect(await sources.send(message('retired'))).toBe('waiting')
    const trigger: Trigger = { id: 't1', source: 'probe', threads: [{ source: 'probe', id: '1' }], actor: { source: 'probe', id: 'u' }, human: true,
      at: '', text: 'hi', meta: { id: 'm1' } }
    const context = sources.threadContext(trigger)!
    expect(context.messageId).toBe('m1')
    expect(await context.read('thread', '2')).toMatchObject({ body: { page: '2' } })
    expect(read).toEqual([['t1', 'thread', '2', 7]])
    sources.register({ ...probe, kind: 'quiet' })
    expect(await sources.send(message('quiet'))).toBe('gone')
    expect(sources.threadContext({ ...trigger, source: 'quiet' })).toBeUndefined()
  })
  it('refuses a kind whose health entry another part reports, and ignores reports after its registration ends', () => {
    const board = new HealthBoard()
    for (const name of ['runtime', 'reply']) board.claim(name)
    const sources = new SourceRegistry(() => ({}), board)
    expect(() => sources.register({ ...probe, kind: 'reply' })).toThrow('declares the health entry reply')
    expect(sources.kind('reply')).toBeUndefined()
    const dispose = sources.register(probe)
    expect(board.all.probe).toEqual({ state: 'starting', detail: '' })
    const first = sources.reporter('probe')
    first({ state: 'ready', detail: 'ok' })
    expect(board.all.probe).toEqual({ state: 'ready', detail: 'ok' })
    first({ state: 'ready', detail: 'part' }, 'part')
    expect(board.all['probe:part']).toEqual({ state: 'ready', detail: 'part' })
    dispose()
    expect(board.all.probe).toBeUndefined()
    expect(board.all['probe:part']).toBeUndefined()
    expect(() => first({ state: 'error', detail: 'late' })).not.toThrow()
    sources.register(probe)
    first({ state: 'error', detail: 'late' })
    expect(board.all.probe).toEqual({ state: 'starting', detail: '' })
    sources.reporter('probe')({ state: 'ready', detail: 'again' })
    expect(board.all.probe).toEqual({ state: 'ready', detail: 'again' })
    expect(() => sources.reporter('missing')).toThrow('not registered')
  })
  it('refuses a second registration of one kind and forgets a kind after its disposer runs', () => {
    const sources = new SourceRegistry(() => ({}))
    const dispose = sources.register(probe)
    expect(() => sources.register(probe)).toThrow('already registered')
    dispose()
    expect(sources.instance('probe')).toBeUndefined()
  })
  it('scopes a Trigger by its kind and config and checks reply channels', () => {
    const disabled = new SourceRegistry(() => ({ probe: { interval: 0 }, retired: {} }))
    disabled.register(probe)
    expect(disabled.scope({ source: 'probe', meta: {} })).toEqual({ listened: false, reason: 'source_disabled' })
    expect(disabled.scope({ source: 'retired', meta: {} })).toEqual({ listened: false, reason: 'source_not_installed' })
    expect(disabled.scope({ source: 'other', meta: {} })).toEqual({ listened: true, observed: false })
    expect(disabled.enabled('probe')).toBe(false)
    expect(disabled.enabled('other')).toBe(false)
    const sources = new SourceRegistry(() => ({}))
    sources.register({ ...probe,
      scope: ({ meta }) => meta.room === 'r' ? { listened: true, observed: true, row: 'r' } : { listened: false, reason: 'room_not_listened' },
      channel: { allowed: address => address.room === 'r', send: async () => 'sent' },
      find: query => ({ threads: [`probe:${query}`], terms: [query] }) })
    expect(sources.scope({ source: 'probe', meta: { room: 'r' } })).toEqual({ listened: true, observed: true, row: 'r' })
    expect(sources.channelAllowed({ source: 'probe', address: { room: 'x' } })).toBe(false)
    expect(sources.channelAllowed({ source: 'probe', address: { room: 'r' } })).toBe(true)
    expect(sources.channelAllowed({ source: 'none', address: { room: 'r' } })).toBe(false)
    expect(sources.enabled('probe')).toBe(true)
    expect(sources.find('7')).toEqual({ threads: ['probe:7'], terms: ['7'] })
  })
})
