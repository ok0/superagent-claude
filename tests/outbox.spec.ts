// Ported from dsh-superagent-prototype (MIT) tests/outbox.spec.ts
/**
 * Outbox delivery when processing is paused or a Source kind registers late.
 * Changes from the reference: runs at unit level with a real Store and Effects and fake channels instead of the Runtime host; the Source is bound through the `OutboxChannels` port; cases are added for receipts across a reopen and for per-Ticket order.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Outbox, type OutboxChannels, type SendResult } from '../src/app/outbox.ts'
import { databasePath, Store } from '../src/app/store.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'

let directory: string
let store: Store
let effects: Effects
let outbox: Outbox
let board: HealthBoard
let clock: number
let paused: boolean
let enabled: Set<string>
let failing: Set<string>
let delivered: string[]
let send = vi.fn(async (_message: OutboundMessage): Promise<SendResult> => 'sent')
let channels: OutboxChannels

const chat = (thread: string) => ({ source: 'chat', thread, address: {} })

function open(): void {
  store = new Store(databasePath(directory))
  board = new HealthBoard()
  effects = new Effects(store, board, () => clock)
  outbox = new Outbox({ store, effects, channels, paused: () => paused })
  effects.start()
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'outbox-'))
  clock = Date.parse('2026-09-09T00:00:00Z')
  paused = false
  enabled = new Set(['chat'])
  failing = new Set()
  delivered = []
  send = vi.fn(async (message: OutboundMessage): Promise<SendResult> => {
    if (failing.delete(message.id)) throw new Error('offline')
    delivered.push(message.id)
    return 'sent'
  })
  channels = { enabled: s => enabled.has(s), allowed: () => true, send }
  open()
})
afterEach(async () => {
  await effects.drain()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  paused = true
  outbox.send({ id: 'held', channel: chat('chat:1'), text: 'Merged.', kind: 'notice' })
  await outbox.sent()
  expect([outbox.status('held'), delivered.length]).toEqual(['pending', 0])
  paused = false
  effects.kick()
  await outbox.sent()
  expect(outbox.status('held')).toBe('sent')
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Merged.' }))
})

it('keeps a message for a Source that is not enabled waiting, and sends it once the Source is enabled', async () => {
  outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await outbox.sent()
  expect([outbox.status('waiting'), board.all.reply?.state]).toEqual(['pending', 'ready'])
  enabled.add('probe')
  // A message whose Source was not enabled is tried again after 5 seconds.
  clock += 4999
  await outbox.sent()
  expect(outbox.status('waiting')).toBe('pending')
  clock += 1
  await outbox.sent()
  expect([outbox.status('waiting'), delivered]).toEqual(['sent', ['waiting']])
})

it('sends a message id once and keeps one receipt', async () => {
  outbox.send({ id: 'm1', channel: chat('chat:1'), text: 'one', kind: 'reply' })
  outbox.send({ id: 'm1', channel: chat('chat:1'), text: 'one', kind: 'reply' })
  await outbox.sent()
  expect(send).toHaveBeenCalledTimes(1)
  expect(Number(store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id = 'm1'").get()!.n)).toBe(1)
  expect(outbox.status('m1')).toBe('sent')
})

it('does not send an id again after the Store reopens', async () => {
  outbox.send({ id: 'm1', channel: chat('chat:1'), text: 'one', kind: 'reply' })
  await outbox.sent()
  await effects.drain()
  store.close()
  open()
  outbox.send({ id: 'm1', channel: chat('chat:1'), text: 'one', kind: 'reply' })
  await outbox.sent()
  expect([delivered, outbox.status('m1')]).toEqual([['m1'], 'sent'])
})

it('sends the messages of one Ticket to one conversation in the order queued, holding later ones behind an earlier failure', async () => {
  failing = new Set(['a'])
  for (const id of ['a', 'b', 'c']) outbox.send({ id, channel: chat('chat:1'), text: id, kind: 'reply', ticketId: 't1' })
  await outbox.sent()
  expect(delivered).toEqual([])
  expect(['a', 'b', 'c'].map(id => outbox.status(id))).toEqual(['pending', 'pending', 'pending'])
  clock += 5000
  await outbox.sent()
  expect(delivered).toEqual(['a', 'b', 'c'])
})
