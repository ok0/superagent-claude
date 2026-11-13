/**
 * A configured branch missing before work starts: the person is told once why, where they last wrote, and
 * told again only after they reply. Other blocks, failures and limits are not told this way.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ticketStage } from '../src/core/stage.ts'
import { recover } from '../src/executor/recovery.ts'
import { WorkspaceBlocked } from '../src/executor/worker-executor.ts'
import { isAiAttributionLine } from '../src/infra/text.ts'
import { accepted, guest, trigger } from './fixtures/engine.ts'
import { workerHarness } from './fixtures/executor.ts'
import { waitUntil } from './fixtures/async.ts'

const REASON =
  'owner/repo has no branch dev, so no workspace was made. A person must create the branch or change branchFrom or pullRequestTo for owner/repo in the config.'
const TEXT = `I could not start this task. ${REASON} Reply here once that is fixed to try again.`
const missing = async (): Promise<never> => {
  throw new WorkspaceBlocked(REASON)
}
const notes = (w: ReturnType<typeof workerHarness>, id: string) =>
  w.outbox.filter(m => m.id.startsWith('workspace-blocked:') && m.ticketId === id)
const blocked = (w: ReturnType<typeof workerHarness>, id: string) =>
  w.ticket(id).assignments.at(-1)?.report?.state === 'blocked'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'workspace-blocked-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

it('tells the person once why the task could not start, with no reply from anyone', async () => {
  const w = workerHarness({ prepare: missing })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => notes(w, id).length === 1)
    const assignment = w.ticket(id).assignments[0]!
    expect(assignment.report).toMatchObject({ state: 'blocked', summary: REASON })
    const messages = notes(w, id)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: `workspace-blocked:${assignment.id}:1`,
      kind: 'reply',
      channel: w.store.triggers.get('1')!.channel,
      ticketId: id,
      text: TEXT,
    })
    const text = messages[0]!.text
    expect(text).toContain('dev')
    expect(text).toContain('A person must')
    expect(/\bM[0-9]+\b/.test(text)).toBe(false)
    expect(/milestone/i.test(text)).toBe(false)
    expect(text.split('\n').some(isAiAttributionLine)).toBe(false)
    expect(/claude|anthropic|generated with|co-authored/i.test(text)).toBe(false)
    expect(w.outbox.filter(m => m.ticketId === id)).toHaveLength(1)
    expect(ticketStage(w.ticket(id))).toEqual({ stage: 'person', action: 'blocked' })
    expect(w.ticket(id).attention).toBeUndefined()
    expect(assignment.limit).toBeUndefined()
    expect(w.runtime.opened).toHaveLength(0)
  } finally {
    await w.close()
  }
})

it('sends nothing and raises nothing when the ticket has no conversation', async () => {
  const w = workerHarness({ prepare: missing })
  try {
    w.engine.receive(trigger('1', { channel: undefined }))
    w.pump()
    const id = w.decide(w.requests.at(-1)!, {
      kind: 'accept',
      title: 'Fix',
      scope: 'small',
      reason: 'requested',
      acknowledgement: 'ok',
    }).ticketId!
    w.settle()
    await waitUntil(() => blocked(w, id))
    expect(w.ticket(id).channels).toHaveLength(0)
    expect(notes(w, id)).toHaveLength(0)
    expect(w.outbox.filter(m => m.ticketId === id)).toHaveLength(0)
    expect(() => w.engine.report(id, { state: 'blocked', summary: REASON, workspace: true })).not.toThrow()
    expect(w.ticket(id).assignments.at(-1)?.report?.state).toBe('blocked')
    expect(notes(w, id)).toHaveLength(0)
  } finally {
    await w.close()
  }
})

it('does not tell twice for one block, and tells again after the person replies or a retry', async () => {
  const w = workerHarness({ directory, prepare: missing })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => notes(w, id).length === 1)
    w.engine.report(id, { state: 'blocked', summary: REASON, workspace: true })
    expect(notes(w, id)).toHaveLength(1)
    w.tick(1)
    w.engine.receive(trigger('2', { actor: guest }))
    w.pump()
    await waitUntil(() => notes(w, id).length === 2)
    expect(notes(w, id)[1]).toMatchObject({
      id: `workspace-blocked:${w.ticket(id).assignments[0]!.id}:2`,
      channel: w.store.triggers.get('2')!.channel,
      text: TEXT,
    })
    expect(w.prepare).toHaveBeenCalledTimes(2)
    w.tick(1)
    w.engine.retryTicket(id)
    await waitUntil(() => notes(w, id).length === 3)
    expect(w.ticket(id).assignments).toHaveLength(2)
    expect(notes(w, id)[2]!.id).toBe(`workspace-blocked:${w.ticket(id).assignments[1]!.id}:2`)
  } finally {
    await w.close()
  }
  const w2 = workerHarness({ directory, start: false, prepare: missing })
  try {
    const id = w2.store.tickets.list()[0]!.id
    recover({ tickets: w2.store.tickets, engine: w2.engine, executor: w2.executor })
    w2.effects.start()
    await w2.effects.idle()
    expect(w2.outbox.filter(m => m.id.startsWith('workspace-blocked:'))).toHaveLength(0)
    expect(w2.prepare).not.toHaveBeenCalled()
    expect(w2.ticket(id).assignments).toHaveLength(2)
  } finally {
    await w2.close()
  }
})

it('refuses the replies a Router could try for the block', async () => {
  const w = workerHarness({ prepare: missing })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => notes(w, id).length === 1)
    expect(() => w.engine.reply({ purpose: 'result', ticketId: id, text: 'Done' })).toThrow()
    expect(() => w.engine.reply({ purpose: 'attention', ticketId: id, question: REASON, text: 'x' })).toThrow()
    expect(() => w.engine.reply({ purpose: 'answer', ticketId: id, triggerId: '1', text: 'x' })).toThrow()
    expect(w.outbox.filter(m => m.ticketId === id)).toHaveLength(1)
  } finally {
    await w.close()
  }
})

it('a failed preparation is not told this way', async () => {
  const w = workerHarness({
    prepare: async () => {
      throw new Error('disk full')
    },
  })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.ticket(id).assignments[0]?.report?.state === 'failed')
    expect(w.ticket(id).assignments[0]!.report!.summary).toBe('The workspace could not be prepared: disk full')
    expect(notes(w, id)).toHaveLength(0)
    w.engine.report(id, { state: 'failed', summary: 'x', workspace: true })
    expect(notes(w, id)).toHaveLength(0)
  } finally {
    await w.close()
  }
})

it('a blocked report from the worker is not told this way', async () => {
  const w = workerHarness({ script: () => ({ hold: new Promise(() => {}) }) })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.runtime.opened.length === 1)
    w.engine.report(id, {
      state: 'blocked',
      summary: 'acme/widgets has no branch dev to open the pull request against. A person must create it.',
    })
    expect(w.ticket(id).assignments[0]!.report!.state).toBe('blocked')
    expect(notes(w, id)).toHaveLength(0)
    expect(ticketStage(w.ticket(id))).toEqual({ stage: 'person', action: 'blocked' })
  } finally {
    await w.close()
  }
})

it('a limit stop keeps its own note only', async () => {
  const w = workerHarness({ script: () => ({ turnEnded: { outcome: 'max_turns' } }) })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.outbox.some(m => m.id.startsWith('limit:') && m.ticketId === id))
    expect(w.outbox.filter(m => m.id.startsWith('limit:') && m.ticketId === id)).toHaveLength(1)
    expect(notes(w, id)).toHaveLength(0)
  } finally {
    await w.close()
  }
})
