/**
 * Runtime-neutral contract suite (docs/runtime-contract.md). Call runtimeContract with a factory that returns the
 * runtime under test for each case; the live suite reruns a subset against the real adapter.
 */
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type AgentRuntime,
  type AgentSession,
  type RuntimeEvent,
  ReadLedger,
  type SessionSpec,
  type ToolSpec,
} from '../../src/executor/contract.ts'
import { waitUntil } from './async.ts'

export const CONTRACT_CASES = [
  'steer joins the running turn',
  'steer in a running turn is reported read before the turn ends',
  'followup starts a new turn',
  'inject does not wake the session',
  'a tool call reaches the host',
  'a turn over the limit ends with a limit outcome',
  'interrupt returns the pending inputs',
  'the host reads each input once',
  'resume keeps the session id',
] as const
export type ContractCase = (typeof CONTRACT_CASES)[number]
/** Instructions a real runtime gets for each case (a scripted runtime may ignore them). */
export const CONTRACT_INSTRUCTIONS: Record<ContractCase, string> = {
  'steer joins the running turn': 'Call the wait tool once, then end your turn.',
  'steer in a running turn is reported read before the turn ends': 'Call the wait tool once, then end your turn.',
  'followup starts a new turn': 'Reply in one short sentence.',
  'inject does not wake the session': 'Reply in one short sentence.',
  'a tool call reaches the host': 'Call the report tool with state ready and summary done.',
  'a turn over the limit ends with a limit outcome': 'Call the wait tool repeatedly.',
  'interrupt returns the pending inputs': 'Reply in one short sentence.',
  'the host reads each input once': 'Reply in one short sentence.',
  'resume keeps the session id': 'Reply in one short sentence.',
}

let contractIndex = 0

/** The spec for one contract case, with the wait and report tools and the reports they collect. */
export function contractSpec(
  name: ContractCase,
  overrides: Partial<SessionSpec> = {},
): { spec: SessionSpec; reports: unknown[] } {
  const reports: unknown[] = []
  contractIndex += 1
  const tools: ToolSpec[] = [
    { name: 'wait', description: 'Wait briefly', schema: z.object({}), execute: async () => 'ok' },
    {
      name: 'report',
      description: 'Report the ticket status',
      schema: z.object({ state: z.string(), summary: z.string() }),
      execute: async args => {
        reports.push(args)
        return 'ok'
      },
    },
  ]
  const spec: SessionSpec = {
    key: `contract-${contractIndex}`,
    role: 'worker',
    cwd: tmpdir(),
    instructions: CONTRACT_INSTRUCTIONS[name],
    tools,
    builtins: { fs: 'none', shell: false, web: false },
    network: { allow: [] },
    limits: { maxTurns: name === 'a turn over the limit ends with a limit outcome' ? 1 : 10, maxBudgetUsd: 1 },
    env: {},
    ...overrides,
  }
  return { spec, reports }
}

type Opened = { session: AgentSession; events: RuntimeEvent[]; reports: unknown[]; ended: (n: number) => Promise<void> }
interface CaseContext {
  open(overrides?: Partial<SessionSpec>): Promise<Opened>
  quiet: () => Promise<void>
  wait: (check: () => boolean) => Promise<unknown>
}

const defaultQuiet = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve))
}

function watch(session: AgentSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of session.events()) events.push(event)
  })()
  return events
}

function readBatches(events: RuntimeEvent[]): string[][] {
  return events.flatMap(event => (event.type === 'inputsRead' ? [event.ids] : []))
}

function readIds(events: RuntimeEvent[]): string[] {
  return readBatches(events).flat()
}

function sessionIdOf(events: RuntimeEvent[]): string | undefined {
  const event = events.find(candidate => candidate.type === 'session')
  return event?.type === 'session' ? event.sessionId : undefined
}

const CHECKS: Record<ContractCase, (c: CaseContext) => Promise<void>> = {
  'steer joins the running turn': async ({ open, quiet }) => {
    const { session, events, ended } = await open()
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    session.send({ id: 'B', text: 'B', mode: 'steer' })
    await ended(1)
    await quiet()
    expect(events.filter(event => event.type === 'turnEnded')).toHaveLength(1)
    expect(readIds(events)).toEqual(expect.arrayContaining(['A', 'B']))
  },
  'steer in a running turn is reported read before the turn ends': async ({ open, quiet }) => {
    const { session, events, ended } = await open()
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    session.send({ id: 'B', text: 'B', mode: 'steer' })
    await ended(1)
    await quiet()
    const read = events.findIndex(event => event.type === 'inputsRead' && event.ids.includes('B'))
    const end = events.findIndex(event => event.type === 'turnEnded')
    expect(read).toBeGreaterThanOrEqual(0)
    expect(read).toBeLessThan(end)
  },
  'followup starts a new turn': async ({ open }) => {
    const { session, events, ended } = await open()
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    session.send({ id: 'B', text: 'B', mode: 'followup' })
    await ended(2)
    const sequence = events
      .filter(event => event.type === 'inputsRead' || event.type === 'turnEnded')
      .map(event => (event.type === 'inputsRead' ? event.ids : 'turnEnded'))
    expect(sequence).toEqual([['A'], 'turnEnded', ['B'], 'turnEnded'])
  },
  'inject does not wake the session': async ({ open, quiet, wait }) => {
    const { session, events, ended } = await open()
    await wait(() => sessionIdOf(events) !== undefined)
    session.send({ id: 'N', text: 'N', mode: 'inject' })
    await quiet()
    expect(events.filter(event => event.type === 'inputsRead' || event.type === 'turnEnded')).toEqual([])
    session.send({ id: 'C', text: 'C', mode: 'followup' })
    await ended(1)
    expect(readBatches(events)[0]).toEqual(expect.arrayContaining(['N', 'C']))
    expect(events.filter(event => event.type === 'turnEnded')).toHaveLength(1)
  },
  'a tool call reaches the host': async ({ open }) => {
    const { session, reports, ended } = await open()
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    await ended(1)
    expect(reports).toEqual([{ state: 'ready', summary: 'done' }])
  },
  'a turn over the limit ends with a limit outcome': async ({ open }) => {
    const { session, events, ended } = await open()
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    await ended(1)
    expect(events.find(event => event.type === 'turnEnded')).toMatchObject({ outcome: 'max_turns' })
  },
  'interrupt returns the pending inputs': async ({ open, wait }) => {
    const { session, events } = await open()
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    session.send({ id: 'B', text: 'B', mode: 'followup' })
    session.send({ id: 'C', text: 'C', mode: 'inject' })
    await wait(() => readIds(events).includes('A'))
    const { stillQueued } = await session.interrupt()
    expect(stillQueued).toEqual(expect.arrayContaining(['B', 'C']))
    expect(stillQueued).not.toContain('A')
  },
  'the host reads each input once': async ({ open }) => {
    const { session, events, ended } = await open()
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    await ended(1)
    const ledger = new ReadLedger()
    const fresh = readBatches(events).flatMap(ids => ledger.fresh(ids))
    expect(fresh).toEqual(['A'])
  },
  'resume keeps the session id': async ({ open, wait }) => {
    const first = await open()
    await wait(() => sessionIdOf(first.events) !== undefined)
    const id = sessionIdOf(first.events)!
    await first.session.close()
    const second = await open({ resume: id })
    await wait(() => sessionIdOf(second.events) !== undefined)
    expect(sessionIdOf(second.events)).toBe(id)
    if (second.session.sessionId !== undefined) expect(second.session.sessionId).toBe(id)
  },
}

/**
 * Adds one `it` per contract case, or only the cases options.cases names, each against a session from factory(case).
 */
export function runtimeContract(
  name: string,
  factory: (contractCase: ContractCase) => AgentRuntime,
  options: { cases?: readonly ContractCase[]; quiet?: () => Promise<void>; timeoutMs?: number } = {},
): void {
  const quiet = options.quiet ?? defaultQuiet
  const timeoutMs = options.timeoutMs ?? 3000
  const wait = (check: () => boolean) => waitUntil(check, timeoutMs)
  describe(`runtime contract: ${name}`, () => {
    for (const contractCase of options.cases ?? CONTRACT_CASES) {
      const body = async () => {
        const runtime = factory(contractCase)
        const sessions: AgentSession[] = []
        const open = async (overrides: Partial<SessionSpec> = {}): Promise<Opened> => {
          const { spec, reports } = contractSpec(contractCase, overrides)
          const session = await runtime.open(spec)
          sessions.push(session)
          const events = watch(session)
          const ended = (n: number) =>
            waitUntil(() => events.filter(event => event.type === 'turnEnded').length >= n, timeoutMs)
          return { session, events, reports, ended }
        }
        try {
          await CHECKS[contractCase]({ open, quiet, wait })
        } finally {
          for (const session of sessions) await session.close()
        }
      }
      if (options.timeoutMs === undefined) it(contractCase, body)
      else it(contractCase, body, options.timeoutMs * 4)
    }
  })
}
