/**
 * The whole daemon over the scripted fake runtime: a mention from an allowed sender opens one Ticket, and the acceptance mode decides whether it does.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../src/app/config.ts'
import { Runtime } from '../src/app/runtime.ts'
import { threadKey } from '../src/core/index.ts'
import { FakeRuntime, type FakeScript } from '../src/runtimes/fake/runtime.ts'
import type { LogRecord } from '../src/sources/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { trigger } from './fixtures/engine.ts'
import { testSource } from './fixtures/source.ts'

let runtime: Runtime | undefined
let directory: string | undefined

afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

async function boot(mode: 'off' | 'observe' | 'auto' | undefined, script: FakeScript, dir: string) {
  const config = ConfigSchema.parse({ repositories: ['owner/repo'], policy: { allowed: ['alice'], ...(mode ? { acceptMode: mode } : {}) }, stateDir: dir })
  const chat = testSource()
  const fake = new FakeRuntime(script)
  const records: LogRecord[] = []
  runtime = new Runtime({ config, runtime: fake, kinds: [chat.kind], services: [chat.service], log: record => { records.push(record) } })
  await runtime.start()
  return { runtime, chat, fake, records }
}

const ready: FakeScript = ({ index }) => index === 0
  ? { tools: [{ name: 'orchestrator_report', args: { state: 'ready', summary: 'Done: the fake worker finished' } }] }
  : {}
const mention = trigger('1', { addressed: 'mention', meta: { repository: 'owner/repo' } })

it('auto: an allowed sender\'s mention opens one Ticket whose fake worker reports and replies once', async () => {
  directory = mkdtempSync(join(tmpdir(), 'e2e-'))
  const { runtime: r, chat, fake, records } = await boot('auto', ready, directory)
  expect(chat.emit(mention)).toBe('stored')
  await waitUntil(() => chat.sent.some(message => message.kind === 'reply'))
  await r.passes.idle()

  const tickets = r.store.tickets.list()
  expect(tickets).toHaveLength(1)
  const ticket = r.store.tickets.get(tickets[0]!.id)!
  expect(ticket.mandate.strength).toBe('explicit')
  expect(ticket.mandate.actor.id).toBe('alice')

  const opened = fake.opened[0]!
  expect(opened.key).toBe(`worker-${ticket.id}`)
  expect(opened.tools.map(tool => tool.name)).toEqual(['orchestrator_ack', 'orchestrator_thread_unrelated', 'orchestrator_thread_follow', 'orchestrator_trigger_handback', 'orchestrator_report'])
  expect(opened.instructions.startsWith('## Host rules')).toBe(true)
  expect(opened.instructions).toContain('## Communication')
  expect(opened.instructions).toContain('<external-data source="ticket-title">')
  expect(r.store.db.prepare('SELECT prompt_version FROM worker WHERE ticket_id = ?').get(ticket.id)?.prompt_version).toBe(r.prompts.version('worker'))

  expect(ticket.assignments.at(-1)!.report!.state).toBe('ready')
  expect(chat.sent).toHaveLength(1)
  const [sent] = chat.sent
  expect(sent).toMatchObject({ kind: 'reply', channel: mention.channel, text: 'Done: the fake worker finished', ticketId: ticket.id })
  expect(r.store.receipts.get(sent!.id)!.status).toBe('sent')
  expect(records.some(record => record.event === 'ticket.created' && record.ticketId === ticket.id)).toBe(true)

  expect(chat.emit(mention)).toBe('duplicate')
  r.outbox.send(sent!)
  await r.outbox.sent()
  await r.passes.idle()
  expect(r.store.tickets.list()).toHaveLength(1)
  expect(chat.sent).toHaveLength(1)
})

it('observe (the default): an explicit mention records would_accept only', async () => {
  directory = mkdtempSync(join(tmpdir(), 'e2e-'))
  const { runtime: r, chat, fake } = await boot(undefined, ready, directory)
  expect(r.config.policy.acceptMode).toBe('observe')
  const enqueue = vi.spyOn(r.effects, 'enqueue')
  expect(chat.emit(mention)).toBe('stored')
  await waitUntil(() => r.store.decisions.byThread(threadKey(mention.threads[0]!)).length === 1)
  await r.passes.idle()

  const [decision] = r.store.decisions.byThread(threadKey(mention.threads[0]!))
  expect(decision!.kind).toBe('ignore')
  expect(decision!.audit?.would_accept).toBe(true)
  expect(r.store.tickets.list()).toHaveLength(0)
  expect(enqueue.mock.calls.some(call => call[0] === 'launch')).toBe(false)
  expect(r.effects.pending('launch')).toBe(false)
  expect(fake.opened).toHaveLength(0)
  expect(chat.sent).toHaveLength(0)
})

it('off: an explicit mention records neither an accept nor would_accept', async () => {
  directory = mkdtempSync(join(tmpdir(), 'e2e-'))
  const { runtime: r, chat, fake } = await boot('off', ready, directory)
  expect(chat.emit(mention)).toBe('stored')
  await waitUntil(() => r.store.decisions.byThread(threadKey(mention.threads[0]!)).length === 1)
  await r.passes.idle()

  const [decision] = r.store.decisions.byThread(threadKey(mention.threads[0]!))
  expect(decision!.kind).toBe('ignore')
  expect(decision!.audit?.would_accept).toBeUndefined()
  expect(r.store.tickets.list()).toHaveLength(0)
  expect(fake.opened).toHaveLength(0)
})
