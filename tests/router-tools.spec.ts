/**
 * Router session tools over a real Engine and Store: the eleven tool names, routing shapes, per-item refusals, the accept mode,
 * ticket and trigger guards, eval tools and reads. Adapted from the reference tools spec (Router cases).
 * Excluded from the reference (ADR-9 and the earlier source-specific surfaces): settings, policy-sync and prompt tools, the
 * earlier registration, the human word limit cases (covered by the word-limit cases of tools.spec), and the failing-source case.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readResource } from '../src/app/resources.ts'
import { MasterAssessor } from '../src/app/assessment.ts'
import { TextCache } from '../src/app/cache.ts'
import { mainTools, type MainToolsHost } from '../src/app/tools/main.ts'
import { ROUTER_TOOLS, TOOL_NAMES } from '../src/app/tool-names.ts'
import { Store, databasePath } from '../src/app/store.ts'
import { Engine, threadKey, type Executor, type Ticket } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy/policy.ts'
import { trigger } from './fixtures/engine.ts'

let dir: string
let store: Store
let engine: Engine
let executor: { start: ReturnType<typeof vi.fn>; deliver: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
let run: (name: string, args: unknown) => Promise<unknown>

function make(acceptMode: 'off' | 'observe' | 'auto' = 'auto') {
  store = new Store(databasePath(dir))
  const settings = SettingsSchema.parse({ policy: { allowed: ['alice'], acceptMode } })
  const scope = { scope: () => ({ listened: true as const, observed: true }) }
  const policy = settingsPolicy(settings, scope)
  const assessor = new MasterAssessor({
    engine: () => engine,
    effects: { enqueue: vi.fn(), handle: vi.fn(), cancel: vi.fn() },
    settings: () => settings,
    paused: () => false,
    threadContext: () => undefined,
    deliver: vi.fn(async () => {}),
    candidateCard: c => ({ trigger_id: c.triggers[0]!.id }),
  })
  executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  engine = new Engine({
    repo: store,
    policy: () => policy,
    scope,
    assessor,
    executor: executor as unknown as Executor,
    outbox,
  })
  const resources = {
    store,
    pages: new TextCache(1000),
    repositories: () => ['owner/repo'],
    repositoryOf: () => undefined,
    skill: () => '',
  }
  const host: MainToolsHost = {
    engine: () => engine,
    store,
    assessor,
    settings: () => settings,
    read: (resource, offset, limit, signal) => readResource(resources, resource, offset, limit, undefined, signal),
    requestPass: vi.fn(),
    sendReplies: async () => {},
    quietly: next => next(),
  }
  const tools = mainTools(host)
  run = (name, args) => {
    const tool = tools.find(item => item.name === name)
    if (!tool) throw new Error(`no tool ${name}`)
    return tool.execute(args, new AbortController().signal)
  }
  return { tools }
}
const accept = (triggerId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'accept',
  trigger_id: triggerId,
  title: 'Fix',
  worktree_name: 'fix-it',
  acknowledgement: 'On it.',
  ...extra,
})
const ticketsOf = () => store.tickets.list() as Ticket[]
/** Receives a mention from an allowed sender and runs the Eval for it, so it is an explicit candidate. */
function explicit(id: string) {
  engine.receive(trigger(id, { addressed: 'mention' }))
  engine.evaluateDue()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'router-tools-'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('router tools', () => {
  it('registers exactly the eleven Router tools', () => {
    const { tools } = make()
    expect(tools.map(tool => tool.name)).toEqual([...ROUTER_TOOLS])
    const names = tools.map(tool => tool.name)
    expect(names).not.toContain('orchestrator_settings_save')
    expect(names).not.toContain('orchestrator_policy_sync')
    expect(names).not.toContain('orchestrator_prompts_save')
    for (const name of names) expect(TOOL_NAMES).toContain(name)
  })

  it('answers routing in one shape, and an accept again keeps the first ticket', async () => {
    make()
    explicit('1')
    const result = (await run('orchestrator_route', { decisions: [accept('1')] })) as {
      results: Record<string, unknown>[]
    }
    expect(result.results[0]).toMatchObject({
      trigger_id: '1',
      kind: 'accept',
      decision: 'accept',
      reason: expect.any(String),
      ticket: expect.objectContaining({ ticket_id: expect.any(String) }),
    })
    expect(executor.start).toHaveBeenCalledTimes(1)
    const again = (await run('orchestrator_route', { decisions: [accept('1')] })) as {
      results: Record<string, unknown>[]
    }
    const id = ticketsOf()[0]!.id
    expect(again.results[0]).toMatchObject({
      decision: 'accept',
      reason: `Already accepted as ${id}; title and acknowledgement unchanged`,
    })
    expect(ticketsOf()).toHaveLength(1)
  })

  it('refuses an item alone', async () => {
    make()
    explicit('1')
    engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] }))
    engine.evaluateDue()
    const { worktree_name: _name, ...missing } = accept('1')
    const result = (await run('orchestrator_route', {
      decisions: [
        missing,
        { kind: 'attach', trigger_id: '1', ticket_id: 'no-such-ticket' },
        { kind: 'ignore', trigger_id: '2', reason: 'Chatter' },
      ],
    })) as { results: Record<string, unknown>[] }
    expect(result.results[0]).toMatchObject({ refused: 'accept needs worktree_name' })
    expect(result.results[1]).toMatchObject({ refused: 'Unknown ticket' })
    expect(result.results[2]).toMatchObject({ trigger_id: '2', decision: 'ignore' })
  })

  it('route accept under observe records what it would accept, without a ticket', async () => {
    make('observe')
    explicit('1')
    const observed = (await run('orchestrator_route', { decisions: [accept('1')] })) as {
      results: Record<string, unknown>[]
    }
    expect(observed.results[0]).toMatchObject({ decision: 'ignore' })
    expect(ticketsOf()).toHaveLength(0)
    const stored = store.decisions.byThread(threadKey({ source: 'chat', id: 't1' })).at(-1)
    expect(stored?.audit).toMatchObject({ would_accept: true })
  })

  it('route accept under off ignores it, without a ticket', async () => {
    make('off')
    explicit('1')
    const off = (await run('orchestrator_route', { decisions: [accept('1')] })) as {
      results: Record<string, unknown>[]
    }
    expect(off.results[0]).toMatchObject({ decision: 'ignore' })
    expect(ticketsOf()).toHaveLength(0)
  })

  it('ticket tools refuse a missing or ended ticket and change nothing', async () => {
    make()
    explicit('1')
    await run('orchestrator_route', { decisions: [accept('1')] })
    const id = ticketsOf()[0]!.id
    await expect(run('orchestrator_ticket_request_status', { ticket_id: 'nope' })).rejects.toThrow('Unknown ticket')
    await expect(run('orchestrator_ticket_note', { ticket_id: 'nope', text: 'x' })).rejects.toThrow('Unknown ticket')
    await expect(run('orchestrator_ticket_retry', { ticket_id: 'nope' })).rejects.toThrow()
    engine.stopTicket(id)
    const inputs = store.tickets.get(id)!.inputs.length
    await expect(run('orchestrator_ticket_request_status', { ticket_id: id })).rejects.toThrow('Ticket has ended')
    await expect(run('orchestrator_ticket_note', { ticket_id: id, text: 'x' })).rejects.toThrow('Ticket has ended')
    await expect(run('orchestrator_ticket_retry', { ticket_id: id })).rejects.toThrow()
    expect(store.tickets.get(id)!.inputs.length).toBe(inputs)
  })

  it('requeue refuses an unknown trigger and a follow-up a worker decides', async () => {
    make()
    explicit('1')
    await run('orchestrator_route', { decisions: [accept('1')] })
    await expect(run('orchestrator_trigger_requeue', { trigger_id: 'nope' })).rejects.toThrow('Unknown trigger')
    engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't1' }] }))
    await expect(run('orchestrator_trigger_requeue', { trigger_id: '2' })).rejects.toThrow(/its worker decides/)
  })

  it('eval tools refuse an explicit candidate and bad arguments', async () => {
    make()
    explicit('1')
    await expect(run('orchestrator_eval', { trigger_id: '1' })).rejects.toThrow(/orchestrator_route/)
    const decision = {
      trigger_id: '1',
      decision: 'ignore',
      rule_assessments: [],
      title: 't',
      scope: 's',
      reason: 'r',
      direction: {
        implementation_requested: false,
        target_basis: 'undetermined',
        requires_design_decision: false,
        evidence: 'e',
      },
    }
    await expect(run('orchestrator_eval_decide', decision)).rejects.toThrow(/orchestrator_route/)
    const { direction: _direction, ...noDirection } = decision
    await expect(run('orchestrator_eval_decide', noDirection)).rejects.toThrow()
    expect(store.decisions.byThread(threadKey({ source: 'chat', id: 't1' }))).toHaveLength(0)
  })

  it('reply refuses a result for a ticket that is not ready, and thread_unsubscribe reports removal', async () => {
    make()
    explicit('1')
    await run('orchestrator_route', { decisions: [accept('1')] })
    const id = ticketsOf()[0]!.id
    await expect(run('orchestrator_reply', { ticket_id: id, purpose: 'result', text: 'Done' })).rejects.toThrow()
    const removed = await run('orchestrator_thread_unsubscribe', { thread: 'chat:t1' })
    expect(removed).toEqual({ removed: expect.any(Boolean), thread: 'chat:t1' })
  })

  it('orchestrator_read rejects an unknown resource', async () => {
    make()
    await expect(run('orchestrator_read', { resource: 'nope/1', offset: 0 })).rejects.toThrow(/Unknown resource/)
  })
})
