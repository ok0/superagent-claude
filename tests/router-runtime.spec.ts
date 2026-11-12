/**
 * Router session at runtime level: candidates are relayed and decided through the Router's tools, batching,
 * unanswered Evals, follow-ups and worker reports.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { THREAD, mention, message, startRuntime, type Host } from './fixtures/host.ts'
import { guest } from './fixtures/engine.ts'
import { waitUntil } from './fixtures/async.ts'

const ACCEPT = {
  decision: 'accept',
  rule_assessments: [
    { rule_id: 'copy', matched: true, reason: 'A typo' },
    { rule_id: 'visual', matched: false, reason: 'No styling' },
  ],
  direction: {
    implementation_requested: true,
    target_basis: 'specified',
    requires_design_decision: false,
    evidence: 'Fix the typo',
  },
  title: 'Fix the typo',
  worktree_name: 'fix-typo',
  scope: 'The typo',
  intent_evidence: '"fix the typo"',
  acknowledgement: 'I will fix the typo.',
  reason: 'A copy fix',
}

let host: Host | undefined

afterEach(async () => {
  await host?.stop()
  host = undefined
})

describe('Router session at runtime level', () => {
  it("relays an inferred candidate, and the Router's accept opens one ticket and its worker", async () => {
    host = await startRuntime()
    host.receive(message('1'))
    await host.idle()
    expect(host.candidates()).toEqual(['1'])
    expect(host.relays().find(relay => relay.kind === 'candidate')).toMatchObject({ strength: 'inferred' })
    await expect(host.routerTool('orchestrator_eval', { trigger_id: '1' })).resolves.toBeDefined()
    await expect(host.routerTool('orchestrator_eval_decide', { trigger_id: '1', ...ACCEPT })).resolves.toMatchObject({
      decision: 'accept',
    })
    await host.pump()
    expect(host.runtime.store.tickets.open()).toHaveLength(1)
    const ticketId = host.runtime.store.tickets.open()[0]!.id
    await waitUntil(() => host!.workerSession(ticketId) !== undefined)
    expect(host.receive(message('1'))).toBe('duplicate')
    await expect(host.routerTool('orchestrator_eval_decide', { trigger_id: '1', ...ACCEPT })).rejects.toThrow(
      /No assessment is in progress/,
    )
    expect(host.runtime.store.tickets.open()).toHaveLength(1)
  })

  it("the host mode wins over the Router's accept", async () => {
    host = await startRuntime({ acceptMode: 'observe' })
    host.receive(message('1'))
    await host.idle()
    await expect(host.routerTool('orchestrator_eval_decide', { trigger_id: '1', ...ACCEPT })).resolves.toMatchObject({
      decision: 'ignore',
    })
    await host.pump()
    expect(host.runtime.store.tickets.open()).toHaveLength(0)
    host.receive(message('5', { actor: guest, threads: [{ source: 'chat', id: 't9' }] }))
    await host.idle()
    expect(host.candidates()).not.toContain('5')
    await expect(host.routerTool('orchestrator_eval_decide', { trigger_id: '5', ...ACCEPT })).rejects.toThrow()
    await host.pump()
    expect(host.runtime.store.tickets.open()).toHaveLength(0)
  })

  it('batches triggers that arrive during an Eval into the next one', async () => {
    host = await startRuntime()
    host.receive(message('1'))
    await host.idle()
    host.receive(message('2'))
    await host.idle()
    expect(host.candidates()).toEqual(['1'])
    expect(host.runtime.store.threads.get(THREAD)?.pending).toEqual(['2'])
    await host.route({ kind: 'ignore', trigger_id: '1', reason: 'Chatter' })
    await host.pump()
    expect(host.candidates()).toEqual(['1', '2'])
  })

  it('keeps a candidate the Router does not answer: it is queued again, then recorded unavailable', async () => {
    host = await startRuntime()
    host.receive(message('1'))
    await host.idle()
    for (let round = 1; round <= 3; round++) {
      host.advance(121_000)
      await host.pump()
      if (round === 1) expect(host.candidates().filter(id => id === '1')).toHaveLength(2)
    }
    expect(host.runtime.store.threads.get(THREAD)?.evaluating).toBeUndefined()
    expect(
      host.runtime.store.decisions
        .byThread(THREAD)
        .some(decision => decision.kind === 'unavailable' && decision.triggerIds.includes('1')),
    ).toBe(true)
  })

  it("delivers a person's message on a ticket's thread to its worker without an Eval, and a hand-back starts one Eval once", async () => {
    host = await startRuntime()
    const { ticket } = await host.acceptedTicket(mention('1'))
    host.receive(message('2', { meta: { repository: 'owner/repo', parent: '1' } }))
    await host.idle()
    expect(host.candidates()).not.toContain('2')
    expect(host.workerInputs(ticket.id).filter(text => text.includes('"trigger_id":"2"'))).toHaveLength(1)
    expect(host.followups().filter(relay => relay.trigger_id === '2')).toHaveLength(1)
    await expect(
      host.workerTool(ticket.id, 'orchestrator_trigger_handback', { trigger_id: '2', reason: 'Another request.' }),
    ).resolves.toMatchObject({ trigger_id: '2', queued: true })
    await host.pump()
    const handed = host.relays().filter(relay => relay.kind === 'candidate' && relay.trigger_id === '2')
    expect(handed).toHaveLength(1)
    expect((handed[0]!.handed_back as { ticket_id: string }[])[0]!.ticket_id).toBe(ticket.id)
    await expect(
      host.workerTool(ticket.id, 'orchestrator_trigger_handback', { trigger_id: '2', reason: 'Again.' }),
    ).rejects.toThrow(/handed that trigger back/)
    await host.pump()
    expect(host.candidates().filter(id => id === '2')).toHaveLength(1)
  })

  it("relays a worker's ready report to the Router instead of replying for it", async () => {
    host = await startRuntime()
    const { ticket } = await host.acceptedTicket(mention('1'))
    await host.workerTool(ticket.id, 'orchestrator_report', { state: 'ready', summary: 'Done' })
    await host.idle()
    expect(host.relays()).toContainEqual(expect.objectContaining({ kind: 'worker_report', state: 'ready' }))
    expect(host.replies()).not.toContain('Done')
  })
})
