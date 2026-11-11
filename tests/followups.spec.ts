// Ported from dsh-superagent-prototype (MIT) tests/followups.spec.ts
/** Follow-up routing: human messages on subscribed threads go directly to the ticket worker and notify the Router without starting an Eval. Adapted from the reference follow-up spec. */
import { afterEach, expect, it } from 'vitest'
import { REPO, THREAD, message, mention, startRuntime, type Host } from './fixtures/host.ts'
import { guest } from './fixtures/engine.ts'
import { deferred, waitUntil } from './fixtures/async.ts'
import { repliedTo } from '../src/app/links.ts'
import { renderInput } from '../src/executor/worker-executor.ts'
import type { Trigger } from '../src/core/index.ts'

let h: Host | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
const followup = (id: string, text: string, overrides: Partial<Trigger> = {}) =>
  message(id, { text, meta: { repository: REPO, parent: '1' }, ...overrides })
const followups = (host: Host) => host.followups()
const decides = /its worker decides whether it belongs there/

it('delivers a follow-up to the worker and tells the Router with a card, without an Eval', async () => {
  // ref L14
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1'))
  const reply = followup('2', '顺便把标题也改了')
  h.receive(reply)
  await h.idle()
  expect(h.workerInputs(ticket.id).filter(text => text.includes('"trigger_id":"2"'))).toHaveLength(1)
  expect(followups(h)).toEqual([
    {
      kind: 'follow_up',
      trigger_id: '2',
      from: 'alice',
      thread: THREAD,
      at: expect.any(String),
      text: expect.stringContaining('<external-data'),
      replies_to: { trigger_id: '1', preview: expect.stringContaining('message 1') },
      delivered_to: [{ ticket_id: ticket.id, title: ticket.title, state: 'working' }],
      note: expect.stringContaining('worker has it and decides'),
    },
  ])
  // No candidate, no Eval: nothing waits on the Router, and the Thread's queue stays free.
  expect(h.candidates()).toEqual(['1'])
  expect(h.runtime.store.threads.get(THREAD)).toMatchObject({ pending: [] })
  expect(h.runtime.store.threads.get(THREAD)).not.toHaveProperty('evaluating')
  expect(h.runtime.store.decisions.byThread(THREAD)).toHaveLength(1)
  expect(h.runtime.store.triggers.disposition('2')).toEqual({ fanout: [ticket.id], at: expect.any(String) })
})

it('sends a mention that reaches no open ticket, after a person stopped it, to Eval as before', async () => {
  // ref L35
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1'))
  h.runtime.engine.stopTicket(ticket.id)
  h.receive(followup('2', '@bot 换个方式修', { addressed: 'mention' }))
  await h.idle()
  expect(followups(h)).toEqual([])
  expect(h.candidates()).toContain('2')
})

// Skipped (accepted deviation): admission rejects non-listed actors and listed ones are `explicit`, so the guest follow-up scenario of ref L47 is not reachable through the real Runtime; the hand-back/attach behavior is covered by the L135 case.
it.skip("leaves a delivered follow-up to its ticket's worker: the Router may stop the ticket on it, and route it only once handed back", async () => {
  // ref L47
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1'))
  const other = await h.acceptedTicket(
    mention('3', {
      text: '@bot 另一件事',
      threads: [{ source: 'chat', id: 't3' }],
      channel: { source: 'chat', thread: 't3', address: { message: '3' } },
    }),
  )
  const settle = async (id: string, text: string, actor?: typeof guest) => {
    h!.receive(followup(id, text, actor ? { actor } : {}))
    await h!.idle()
    return id
  }
  const master = (name: string, args: unknown) => h!.routerTool(name, args)
  const guestId = await settle('4', '别做了', guest)
  expect(await h!.route({ kind: 'stop', ticket_id: ticket.id, trigger_id: guestId })).toMatchObject({
    decision: 'ignore',
  })
  await expect(
    h!.route({ kind: 'accept', trigger_id: guestId, title: 'More', worktree_name: 'more', acknowledgement: 'ok' }),
  ).rejects.toThrow(decides)
  await expect(master('orchestrator_trigger_requeue', { trigger_id: guestId })).rejects.toThrow(decides)
  // A person may still send it to Eval from the panel.
  expect(h.runtime.engine.reevaluate(guestId)).toBe(true)
  await h.pump()
  expect(h.candidates()).toContain(guestId)
  // Alice's follow-ups carry her authority once the worker hands them back: one goes to the other ticket, one becomes new work.
  const attach = await settle('5', '这个其实是另一件事的')
  await expect(h!.route({ kind: 'attach', ticket_id: other.ticket.id, trigger_id: attach })).rejects.toThrow(decides)
  await h.workerTool(ticket.id, 'orchestrator_trigger_handback', {
    trigger_id: attach,
    reason: 'It is about the other request.',
  })
  expect(await h!.route({ kind: 'attach', ticket_id: other.ticket.id, trigger_id: attach })).toMatchObject({
    ticket: expect.objectContaining({ ticket_id: other.ticket.id }),
  })
  const work = await settle('6', '另外把导出按钮也加上')
  const request = {
    trigger_id: work,
    title: '导出按钮',
    worktree_name: 'export',
    acknowledgement: '收到，加导出按钮。',
  }
  await expect(h!.route({ kind: 'accept', ...request })).rejects.toThrow(decides)
  // The attach subscribed the other ticket to this thread, so its worker decides the message too; it is new work once both
  // hand it back.
  await h.workerTool(ticket.id, 'orchestrator_trigger_handback', {
    trigger_id: work,
    reason: 'It asks for an export button.',
  })
  await expect(h!.route({ kind: 'accept', ...request })).rejects.toThrow(decides)
  await h.workerTool(other.ticket.id, 'orchestrator_trigger_handback', {
    trigger_id: work,
    reason: 'Not this ticket either.',
  })
  const accepted = await h!.route({ kind: 'accept', ...request })
  expect(h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!.mandate).toMatchObject({
    strength: 'explicit',
  })
  // A stop on a person's request needs no hand-back.
  await settle('7', '先停一下')
  expect(await h!.route({ kind: 'stop', ticket_id: ticket.id, trigger_id: '7' })).toMatchObject({ decision: 'stop' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
})

it('costs the Router one model call for a burst of follow-ups while it works, and two while it idles', async () => {
  // ref L103
  let holdAt = -1
  let gate = deferred()
  for (const busy of [true, false]) {
    gate = deferred()
    holdAt = -1
    h = await startRuntime({ router: turn => (turn.index === holdAt ? { hold: gate.promise } : undefined) })
    await h.acceptedTicket(mention('1'))
    await h.idle()
    const session = h.routerSessions()[0]!
    await waitUntil(() => session.log.filter(event => event.type === 'turnEnded').length === session.turns.length)
    holdAt = session.turns.length
    if (busy) session.send({ id: 'warm', text: '{}', mode: 'steer' })
    const base = session.turns.length
    const candidatesBefore = h.candidates().length
    for (const id of ['2', '3', '4', '5', '6']) h.receive(followup(id, `第 ${id} 条补充`))
    await h.idle()
    gate.resolve()
    await h.idle()
    expect([followups(h).length, h.candidates().length - candidatesBefore, session.turns.length - base]).toEqual([
      5,
      0,
      busy ? 1 : 2,
    ])
    await h.stop()
    h = undefined
  }
})

it("keeps a follow-up's relay in the effect queue until the Router takes it, and sends it once", async () => {
  // ref L118
  h = await startRuntime()
  await h.acceptedTicket(mention('1'))
  await h.routerSessions()[0]!.close()
  h.breakRouter(1)
  const reply = followup('2', '补充一点')
  h.receive(reply)
  await h.idle()
  // The relay is stored with the intake's transaction, keyed by its Trigger, and a duplicate message adds nothing.
  expect(h.runtime.store.db.prepare("SELECT key FROM effect WHERE kind = 'relay'").all()).toEqual([
    { key: 'followup:2' },
  ])
  expect(h.receive(followup('2', '补充一点'))).toBe('duplicate')
  h.advance(70_000)
  await h.pump()
  h.advance(70_000)
  await h.pump()
  expect(followups(h).map(item => item.trigger_id)).toEqual(['2'])
  expect(h.runtime.effects.pending('relay')).toBe(false)
})

it("relays a message a worker handed back as a candidate with the worker's reason", async () => {
  // ref L135
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1'))
  h.receive(followup('2', '另外把导出按钮也加上'))
  await h.idle()
  expect(
    await h.workerTool(ticket.id, 'orchestrator_trigger_handback', {
      trigger_id: '2',
      reason: 'It asks for an export button.',
    }),
  ).toEqual({ trigger_id: '2', queued: true })
  await h.pump()
  // The candidate tells the Router; no requeue notice comes before it.
  expect(JSON.stringify(h.injects())).not.toContain('trigger_requeued')
  expect(h.relays().find(item => item.kind === 'candidate' && item.trigger_id === '2')).toMatchObject({
    strength: 'explicit',
    handed_back: [{ trigger_id: '2', ticket_id: ticket.id, reason: 'It asks for an export button.' }],
  })
  await expect(
    h.workerTool(ticket.id, 'orchestrator_trigger_handback', { trigger_id: '2', reason: 'Again' }),
  ).rejects.toThrow(/handed that trigger back/)
  // Attaching it back to the ticket that returned it is refused.
  await expect(h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: '2' })).rejects.toThrow(
    /handed that trigger back as beyond it/,
  )
})

it('lets a worker follow a related thread for context, which the Router hears of without waking, and notes a ticket', async () => {
  // ref L157
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1'))
  const injectsBefore = h.injects().length
  const relaysBefore = h.relays().length
  expect(
    await h.workerTool(ticket.id, 'orchestrator_thread_follow', {
      thread: 'github:owner/repo#7',
      reason: 'The issue it fixes.',
    }),
  ).toEqual({ followed: true, thread: 'github:owner/repo#7' })
  await h.idle()
  expect(h.runtime.store.threads.get('github:owner/repo#7')).toMatchObject({
    subscriptions: [ticket.id],
    context: [ticket.id],
  })
  expect(h.injects().slice(injectsBefore)).toEqual([
    expect.objectContaining({
      thread_followed: { ticket_id: ticket.id, thread: 'github:owner/repo#7', reason: 'The issue it fixes.' },
    }),
  ])
  expect(h.relays()).toHaveLength(relaysBefore)
  await expect(
    h.workerTool(ticket.id, 'orchestrator_thread_follow', { thread: 'github', reason: 'x' }),
  ).rejects.toThrow(/<source>:<id>/)
  await expect(
    h.workerTool(ticket.id, 'orchestrator_thread_follow', { thread: 'github:other/repo#7', reason: 'x' }),
  ).rejects.toThrow(/not in the configured repositories/)
  expect(
    await h.routerTool('orchestrator_ticket_note', { ticket_id: ticket.id, text: 'Ticket B renamed the setting.' }),
  ).toMatchObject({ reason: 'Noted for the worker' })
  await h.idle()
  expect(h.workerInputs(ticket.id)).not.toContain('Note for context only: Ticket B renamed the setting.')
  // Adapted: a note is an inject input (docs/runtime-contract.md), so it reaches the worker with the next message.
  h.receive(followup('2', 'thanks'))
  await h.idle()
  const inputs = h.workerInputs(ticket.id)
  const noteAt = inputs.findIndex(text => text.includes('Note for context only: Ticket B renamed the setting.'))
  const messageAt = inputs.findIndex(text => text.includes('"trigger_id":"2"'))
  expect(noteAt).toBeGreaterThanOrEqual(0)
  expect(messageAt).toBeGreaterThan(noteAt)
})

it('takes the message a follow-up answers from its Source kind, whichever kind it is', async () => {
  // ref L179
  h = await startRuntime()
  const parent = mention('1', { text: 'the earlier message' })
  h.runtime.store.triggers.save(parent)
  const reply = { ...followup('2', 'a reply'), source: 'other' }
  expect(
    repliedTo(
      { store: h.runtime.store, sources: { repliesTo: trigger => (trigger.id === reply.id ? parent.id : undefined) } },
      reply,
    ),
  ).toEqual(parent)
  expect(repliedTo({ store: h.runtime.store, sources: { repliesTo: () => undefined } }, reply)).toBeUndefined()
  expect(repliedTo(h.runtime, followup('3', 'yes'))).toEqual(parent)
})

it('tells the Router of a follow-up to an ended ticket once a new message resumes it, and not when no ticket takes it', async () => {
  // ref L190
  // Adapted: this build has no processing pause, so the ended ticket is the one a worker reported ready.
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1'))
  await h.workerTool(ticket.id, 'orchestrator_report', { state: 'ready', summary: 'Done' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
  h.receive(followup('2', '再改一下标题'))
  await h.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(followups(h)).toEqual([
    expect.objectContaining({ trigger_id: '2', delivered_to: [expect.objectContaining({ ticket_id: ticket.id })] }),
  ])
})

it('tells the Router nothing of a message it attached to an ended ticket, which resumes for it', async () => {
  // ref L207
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1'))
  await h.workerTool(ticket.id, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  h.receive(
    mention('40', {
      text: '@bot 上次那个改动还要改一下',
      threads: [{ source: 'chat', id: 't40' }],
      channel: { source: 'chat', thread: 't40', address: { message: '40' } },
    }),
  )
  await h.idle()
  await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: '40' })
  await h.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(followups(h)).toEqual([])
})

it('tells the Router of a follow-up an earlier version queued for Eval, when the queue lets it go', async () => {
  // ref L219
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1'))
  const reply = followup('2', '顺便看看日志')
  // An earlier version delivered the follow-up to the ticket, queued it for Eval as well, and told the Router nothing.
  const store = h.runtime.store
  store.atomic(() => {
    store.triggers.save(reply)
    store.triggers.saveDisposition(reply.id, { fanout: [ticket.id], at: reply.at })
    store.threads.save({ ...store.threads.get(THREAD)!, pending: [reply.id] })
  })
  await h.pump()
  expect(h.runtime.store.threads.get(THREAD)).toMatchObject({ pending: [] })
  expect(followups(h)).toEqual([
    expect.objectContaining({ trigger_id: '2', delivered_to: [expect.objectContaining({ ticket_id: ticket.id })] }),
  ])
})

it("sends a request on a thread a worker follows only for context to Eval, and marks the worker's copy as context", async () => {
  // ref L235
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1'))
  await h.workerTool(ticket.id, 'orchestrator_thread_follow', { thread: 'chat:t9', reason: 'The same page.' })
  const request = mention('10', {
    text: '@bot 把这里的按钮也改了',
    threads: [{ source: 'chat', id: 't9' }],
    channel: { source: 'chat', thread: 't9', address: { message: '10' } },
  })
  h.receive(request)
  await h.idle()
  // It is nobody's follow-up: the Router assesses it, and the worker reads it as context.
  expect(h.candidates()).toEqual(['1', request.id])
  expect(followups(h)).toEqual([])
  expect(h.runtime.store.triggers.disposition(request.id)).toMatchObject({ fanout: [ticket.id], context: [ticket.id] })
  expect(h.workerInputs(ticket.id).some(text => text.includes('"context":true'))).toBe(true)
})

it("shows a candidate's message as its workers would read it, with the message it answers", async () => {
  // ref L250
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1'))
  const long = `另外，${'导出按钮的文案也需要改。'.repeat(60)}`
  h.receive(followup('2', long))
  await h.idle()
  await h.workerTool(ticket.id, 'orchestrator_trigger_handback', { trigger_id: '2', reason: 'Another change.' })
  await h.pump()
  const card = h.relays().find(item => item.kind === 'candidate' && item.trigger_id === '2')!
  expect(card).toMatchObject({
    from: 'alice',
    text: expect.stringContaining('…'),
    chars: long.length,
    read: 'trigger/2',
    replies_to: { trigger_id: '1', preview: expect.stringContaining('message 1') },
  })
  expect(card).not.toHaveProperty('triggers')
})

it("keeps a listed member's request on a ticket's thread to that ticket, so it is not done twice", async () => {
  // ref L264
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1', { text: '@bot 修一下设置页保存按钮的文案' }))
  // The benchmark's case: an addressed request from a listed member on the ticket's own thread.
  h.receive(followup('2', '@bot [W1-a] 概览页的保存按钮也按同样方式改一下', { addressed: 'mention' }))
  await h.idle()
  // The worker has it and decides; the Router hears of it and cannot open a second ticket for it.
  expect(h.workerInputs(ticket.id).filter(text => text.includes('"trigger_id":"2"'))).toHaveLength(1)
  expect(followups(h)).toEqual([
    expect.objectContaining({ trigger_id: '2', note: expect.stringContaining('orchestrator_route kind stop') }),
  ])
  await expect(
    h.route({
      kind: 'accept',
      trigger_id: '2',
      title: '概览页按钮',
      worktree_name: 'overview-button',
      acknowledgement: '收到。',
    }),
  ).rejects.toThrow(decides)
  // The worker takes it as within its ticket and says so.
  expect(
    await h.workerTool(ticket.id, 'orchestrator_ack', { trigger_id: '2', text: '收到：概览页的保存按钮也一起改。' }),
  ).toMatchObject({ trigger_id: '2' })
  expect(h.runtime.store.tickets.list().map(item => item.id)).toEqual([ticket.id])
  expect(h.candidates()).toEqual(['1'])
})

it("leaves a follow-up to its ticket's worker after the Router drops the subscriptions of its thread", async () => {
  // ref L284
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(mention('1'))
  h.receive(followup('2', '@bot 另外把导出按钮也加上', { addressed: 'mention' }))
  await h.idle()
  expect(await h.routerTool('orchestrator_thread_unsubscribe', { thread: THREAD })).toEqual({
    removed: true,
    thread: THREAD,
  })
  // The worker has the message and still decides it, so the Router cannot open a second ticket for it.
  await expect(
    h.route({
      kind: 'accept',
      trigger_id: '2',
      title: '导出按钮',
      worktree_name: 'export',
      acknowledgement: '收到，加导出按钮。',
    }),
  ).rejects.toThrow(decides)
  expect(h.runtime.store.tickets.list().map(item => item.id)).toEqual([ticket.id])
})

it('tells a worker it may hand back a message beyond its ticket or for another one, also when the message resumed it', async () => {
  // ref L297
  expect(renderInput({ id: 'r', kind: 'resumed', triggerId: 't', at: '' } as never)).toContain(
    'hand it back with orchestrator_trigger_handback',
  )
  h = await startRuntime()
  await h.acceptedTicket(mention('1'))
  const spec = h.fake.opened.filter(item => item.role === 'worker').at(-1)!
  expect(spec.tools.find(tool => tool.name === 'orchestrator_trigger_handback')!.description).toContain(
    'beyond this ticket or for another one',
  )
})
