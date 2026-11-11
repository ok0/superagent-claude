/**
 * Runtime host for Router-session tests: a Runtime in session mode over the scripted fake runtime, with a chat Source, a
 * controllable clock, and a switch that makes the next Router opens fail. It exposes what the Router and the workers were sent.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type Config } from '../../src/app/config.ts'
import { Runtime } from '../../src/app/runtime.ts'
import type { ReceiveResult, Ticket, Trigger } from '../../src/core/index.ts'
import type { AgentRuntime, SessionSpec } from '../../src/executor/contract.ts'
import { workerKey } from '../../src/executor/worker-executor.ts'
import { FakeRuntime, type FakeScript, type FakeSession } from '../../src/runtimes/fake/runtime.ts'
import { waitUntil } from './async.ts'
import { trigger } from './engine.ts'
import { testSource } from './source.ts'

export const REPO = 'owner/repo'
export const THREAD = 'chat:t1'

/** A message from the allowed member `alice` on the default thread, in the repository `REPO`. */
export function message(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return trigger(id, { meta: { repository: REPO }, ...overrides })
}

/** A message that addresses the agent explicitly. */
export function mention(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return message(id, { addressed: 'mention', ...overrides })
}

export interface HostOptions {
  acceptMode?: 'off' | 'observe' | 'auto'
  router?: FakeScript
  worker?: FakeScript
  configDir?: string
}

export interface Host {
  runtime: Runtime
  fake: FakeRuntime
  dir: string
  receive(trigger: Trigger): ReceiveResult
  idle(): Promise<void>
  pump(): Promise<void>
  advance(ms: number): void
  routerSessions(): FakeSession[]
  relays(): Record<string, unknown>[]
  injects(): Record<string, unknown>[]
  candidates(): string[]
  followups(): Record<string, unknown>[]
  replies(): string[]
  workerSession(ticketId: string): FakeSession | undefined
  /** Texts sent to every worker session of the ticket, in open order. */
  workerInputs(ticketId: string): string[]
  routerTool(name: string, args: unknown): Promise<unknown>
  workerTool(ticketId: string, name: string, args: unknown): Promise<unknown>
  route(item: Record<string, unknown>): Promise<Record<string, unknown>>
  acceptedTicket(trigger: Trigger): Promise<{ ticket: Ticket }>
  breakRouter(times: number): void
  stop(): Promise<void>
}

function parsed(inputs: { text: string; mode: string }[], mode: string): Record<string, unknown>[] {
  return inputs
    .filter(input => input.mode === mode)
    .flatMap(input => {
      try {
        return [JSON.parse(input.text) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

export async function startRuntime(options: HostOptions = {}): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), 'router-runtime-'))
  const config: Config = ConfigSchema.parse({
    repositories: [REPO],
    policy: { allowed: ['alice'], acceptMode: options.acceptMode ?? 'auto' },
    stateDir: join(dir, 'state'),
  })
  const chat = testSource('chat', {
    scope: () => ({ listened: true, observed: true }),
    repliesTo: t => (typeof t.meta.parent === 'string' ? t.meta.parent : undefined),
  })
  const fake = new FakeRuntime(turn => (turn.spec.role === 'router' ? options.router?.(turn) : options.worker?.(turn)))
  let offset = 0
  let broken = 0
  const agentRuntime: AgentRuntime = {
    id: 'fake',
    probe: () => fake.probe(),
    open: async spec => {
      if (spec.role === 'router' && broken > 0) {
        broken--
        throw new Error('router unavailable')
      }
      return fake.open(spec)
    },
  }
  const runtime = new Runtime({
    config,
    runtime: agentRuntime,
    router: 'session',
    kinds: [chat.kind],
    services: [chat.service],
    now: () => Date.now() + offset,
    ...(options.configDir ? { configDir: options.configDir } : {}),
  })
  await runtime.start()

  const routerSessions = (): FakeSession[] => fake.sessions.filter(session => session.spec.role === 'router')
  const lastSpec = (role: SessionSpec['role'], key?: string): SessionSpec | undefined =>
    fake.opened.filter(spec => spec.role === role && (key === undefined || spec.key === key)).at(-1)
  const callTool = async (spec: SessionSpec | undefined, name: string, args: unknown): Promise<unknown> => {
    const tool = spec?.tools.find(candidate => candidate.name === name)
    if (!tool) throw new Error(`No tool ${name} in the session`)
    return tool.execute(args, new AbortController().signal)
  }
  const workerSession = (ticketId: string): FakeSession | undefined =>
    fake.sessions.find(session => session.spec.key === workerKey(ticketId))
  const workerSessions = (ticketId: string): FakeSession[] =>
    fake.sessions.filter(session => session.spec.key === workerKey(ticketId))
  const relaysOf = (): Record<string, unknown>[] => routerSessions().flatMap(session => parsed(session.sent, 'steer'))

  const host: Host = {
    runtime,
    fake,
    dir,
    receive: trigger => chat.emit(trigger),
    idle: () => runtime.passes.idle(),
    pump: async () => {
      await runtime.passes.pump()
      await runtime.passes.idle()
    },
    advance: ms => {
      offset += ms
    },
    routerSessions,
    relays: relaysOf,
    injects: () => routerSessions().flatMap(session => parsed(session.sent, 'inject')),
    candidates: () =>
      relaysOf()
        .filter(relay => relay.kind === 'candidate')
        .map(relay => String(relay.trigger_id)),
    followups: () => relaysOf().filter(relay => relay.kind === 'follow_up'),
    replies: () => chat.sent.map(message => String(message.text)),
    workerSession,
    workerInputs: ticketId => workerSessions(ticketId).flatMap(session => session.sent.map(input => input.text)),
    routerTool: (name, args) => callTool(lastSpec('router'), name, args),
    workerTool: (ticketId, name, args) => callTool(lastSpec('worker', workerKey(ticketId)), name, args),
    route: async item => {
      const out = (await host.routerTool('orchestrator_route', { decisions: [item] })) as {
        results: Record<string, unknown>[]
      }
      const result = out.results[0]!
      if (typeof result.refused === 'string') throw new Error(result.refused)
      return result
    },
    acceptedTicket: async accepted => {
      host.receive(accepted)
      await host.idle()
      await host.route({
        kind: 'accept',
        trigger_id: accepted.id,
        title: 'Fix',
        worktree_name: 'fix-it',
        acknowledgement: 'On it.',
      })
      await waitUntil(() => runtime.store.tickets.open().some(ticket => ticket.origin.triggerIds.includes(accepted.id)))
      const ticket = runtime.store.tickets.open().find(candidate => candidate.origin.triggerIds.includes(accepted.id))!
      await waitUntil(() => workerSession(ticket.id) !== undefined)
      return { ticket }
    },
    breakRouter: times => {
      broken = times
    },
    stop: async () => {
      await runtime.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return host
}
