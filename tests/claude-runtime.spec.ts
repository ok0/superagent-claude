/** Claude runtime adapter over a stubbed SDK query: session ids, followup, inject and steer delivery, interrupt, failure, close, probe and the MCP bridge. */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import type { RuntimeEvent, SessionSpec, ToolSpec } from '../src/executor/contract.ts'
import { toolHandler } from '../src/runtimes/claude/mcp.ts'
import { CLAUDE_SDK_VERSION, ClaudeRuntime, INJECT_SEPARATOR } from '../src/runtimes/claude/runtime.ts'
import { waitUntil } from './fixtures/async.ts'
import { result, stubSdk, type StubQuery } from './fixtures/claude-sdk-stub.ts'
import { contractSpec } from './fixtures/runtime-contract.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
const ticks = async (n: number) => { for (let i = 0; i < n; i++) await tick() }

async function open(sdk: ReturnType<typeof stubSdk>, overrides: Partial<SessionSpec> = {}) {
  const { spec } = contractSpec('followup starts a new turn', overrides)
  const runtime = new ClaudeRuntime({ mode: 'subscription', configDir: '/tmp/c', env: { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 't' }, query: sdk.query, sandboxAvailable: () => true })
  const session = await runtime.open(spec)
  const events: RuntimeEvent[] = []
  void (async () => { for await (const event of session.events()) events.push(event) })()
  return { session, events, stub: sdk.queries[sdk.queries.length - 1] as StubQuery }
}

const turnEnds = (events: RuntimeEvent[]) => events.filter(event => event.type === 'turnEnded')
const reads = (events: RuntimeEvent[]) => events.flatMap(event => event.type === 'inputsRead' ? event.ids : [])

describe('claude runtime', () => {
  it('open emits session first and passes a new session id', async () => {
    const sdk = stubSdk()
    const { events, stub } = await open(sdk)
    await waitUntil(() => events.length > 0)
    const first = events[0]!
    expect(first.type).toBe('session')
    expect(first.type === 'session' && first.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(stub.options.sessionId).toBe(first.type === 'session' ? first.sessionId : undefined)
    expect(stub.options.permissionMode).toBe('dontAsk')
  })

  it('resume passes the stored session id', async () => {
    const sdk = stubSdk()
    const { events, stub } = await open(sdk, { resume: 'S1' })
    await waitUntil(() => events.length > 0)
    expect(stub.options.resume).toBe('S1')
    expect(stub.options.sessionId).toBeUndefined()
    expect(events[0]).toEqual({ type: 'session', sessionId: 'S1' })
  })

  it('followup is sent only after the running turn\'s result', async () => {
    const sdk = stubSdk()
    const { session, events, stub } = await open(sdk)
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    await waitUntil(() => stub.received.length === 1)
    expect(stub.received[0]!.message.content).toBe('A')
    session.send({ id: 'B', text: 'B', mode: 'followup' })
    await ticks(3)
    expect(stub.received).toHaveLength(1)
    stub.push(result(stub.received[0]!.uuid, 0.001))
    await waitUntil(() => stub.received.length === 2)
    expect(stub.received[1]!.message.content).toBe('B')
    await waitUntil(() => turnEnds(events).length === 1)
    await ticks(3)
    expect(turnEnds(events)).toHaveLength(1)
  })

  it('inject is merged into the next input and never sent alone', async () => {
    const sdk = stubSdk()
    const { session, events, stub } = await open(sdk)
    session.send({ id: 'N', text: 'N', mode: 'inject' })
    await ticks(3)
    expect(stub.received).toHaveLength(0)
    expect(events.filter(event => event.type === 'inputsRead' || event.type === 'turnEnded')).toEqual([])
    session.send({ id: 'C', text: 'C', mode: 'followup' })
    await waitUntil(() => stub.received.length === 1)
    expect(stub.received[0]!.message.content).toBe('N' + INJECT_SEPARATOR + 'C')
    await stub.hook('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt: '' })
    await waitUntil(() => reads(events).length === 2)
    expect(reads(events)).toEqual(['N', 'C'])
  })

  it('steer is sent into the running turn with priority next', async () => {
    const sdk = stubSdk()
    const { session, events, stub } = await open(sdk)
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    session.send({ id: 'S', text: 'S', mode: 'steer' })
    await waitUntil(() => stub.received.length === 2)
    expect(stub.received[1]!.priority).toBe('next')
    expect(stub.received[0]!.priority).toBeUndefined()
    await stub.hook('PostToolBatch', { hook_event_name: 'PostToolBatch' })
    await waitUntil(() => reads(events).length === 2)
    expect(reads(events)).toEqual(['A', 'S'])
  })

  it('interrupt returns held and SDK-queued ids and suppresses the turn result', async () => {
    const sdk = stubSdk()
    const { session, events, stub } = await open(sdk)
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    session.send({ id: 'S', text: 'S', mode: 'steer' })
    session.send({ id: 'B', text: 'B', mode: 'followup' })
    session.send({ id: 'C', text: 'C', mode: 'inject' })
    await waitUntil(() => stub.received.length === 2)
    stub.receipt = [stub.received[1]!.uuid!]
    const { stillQueued } = await session.interrupt()
    expect(stillQueued).toEqual(expect.arrayContaining(['S', 'B', 'C']))
    expect(stillQueued).not.toContain('A')
    expect(stub.interrupts).toBe(1)
    stub.push(result(stub.received[0]!.uuid, 0.002, 'error_during_execution'))
    await waitUntil(() => turnEnds(events).length === 1)
    expect(turnEnds(events)[0]).toMatchObject({ type: 'turnEnded', discarded: true })
  })

  it('interrupt on an idle session returns only held ids without calling the SDK', async () => {
    const sdk = stubSdk()
    const { session, stub } = await open(sdk)
    session.send({ id: 'C', text: 'C', mode: 'inject' })
    await expect(session.interrupt()).resolves.toEqual({ stillQueued: ['C'] })
    expect(stub.interrupts).toBe(0)
  })

  it('a stream failure emits a non-retryable error and then closed', async () => {
    const sdk = stubSdk()
    const { session, events, stub } = await open(sdk)
    stub.fail(new Error('boom'))
    await waitUntil(() => events.at(-1)?.type === 'closed')
    expect(events.slice(-2)).toEqual([{ type: 'error', message: 'boom', retryable: false }, { type: 'closed' }])
    expect(() => session.send({ id: 'X', text: 'X', mode: 'followup' })).toThrow('The session is closed')
  })

  it('close ends the query and emits closed last', async () => {
    const sdk = stubSdk()
    const { session, events, stub } = await open(sdk)
    await waitUntil(() => events.length > 0)
    await session.close()
    expect(stub.closed).toBe(true)
    await waitUntil(() => events.at(-1)?.type === 'closed')
    const count = events.length
    await ticks(3)
    expect(events).toHaveLength(count)
    expect(events.at(-1)).toEqual({ type: 'closed' })
  })

  it('probe reports sandbox and the pinned version', async () => {
    const sdk = stubSdk()
    const runtime = new ClaudeRuntime({ mode: 'subscription', configDir: '/tmp/c', query: sdk.query, sandboxAvailable: () => true })
    expect(await runtime.probe()).toEqual({ sandbox: true, version: CLAUDE_SDK_VERSION })
    const off = new ClaudeRuntime({ mode: 'subscription', configDir: '/tmp/c', query: sdk.query, sandbox: false, sandboxAvailable: () => true })
    expect((await off.probe()).sandbox).toBe(false)
    const pinned = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> }
    expect(CLAUDE_SDK_VERSION).toBe(pinned.dependencies['@anthropic-ai/claude-agent-sdk'])
  })

  it('tool calls through the MCP server reach execute', async () => {
    const sdk = stubSdk()
    const { stub } = await open(sdk)
    expect(stub.options.mcpServers?.superagent).toBeDefined()
    expect(stub.options.allowedTools).toContain('mcp__superagent__report')
  })

  it('an invalid human_action through MCP is a tool error', async () => {
    const engine = {
      report: vi.fn((_ticketId: string, _report: unknown) => ({ attention: undefined })),
      reply: vi.fn(() => ({ id: 'r1', status: 'pending', reused: false })),
      handback: vi.fn(() => true),
      followForContext: vi.fn(() => true),
      markUnrelated: vi.fn(),
    }
    const host: ExecutorToolsHost = { engine: () => engine as never, ticket: () => ({} as never) }
    const report = executorTools(host, { id: 'T1' }).find((item: ToolSpec) => item.name === 'orchestrator_report')!
    const handler = toolHandler(report, new AbortController().signal)
    const bad = await handler({ state: 'progress', summary: 's', human_action: 'Approve? Merge?' })
    expect(bad.isError).toBe(true)
    expect(engine.report).not.toHaveBeenCalled()
    const good = await handler({ state: 'progress', summary: 's', human_action: 'Can you grant push access?' })
    expect(good.isError).toBeFalsy()
    expect(engine.report).toHaveBeenCalledTimes(1)
  })

  it('a suppressed result does not release followups held behind the newer turn', async () => {
    const sdk = stubSdk()
    const { session, events, stub } = await open(sdk)
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    await waitUntil(() => stub.received.length === 1)
    await session.interrupt()
    session.send({ id: 'B', text: 'B', mode: 'followup' })
    await waitUntil(() => stub.received.length === 2)
    expect(stub.received[1]!.message.content).toBe('B')
    session.send({ id: 'C', text: 'C', mode: 'followup' })
    await ticks(3)
    expect(stub.received).toHaveLength(2)
    stub.push(result(stub.received[0]!.uuid, 0.001, 'error_during_execution'))
    await ticks(5)
    expect(stub.received).toHaveLength(2)
    await waitUntil(() => turnEnds(events).length === 1)
    expect(turnEnds(events)[0]).toMatchObject({ type: 'turnEnded', discarded: true })
    stub.push(result(stub.received[1]!.uuid, 0.002))
    await waitUntil(() => stub.received.length === 3)
    expect(stub.received[2]!.message.content).toBe('C')
    await waitUntil(() => turnEnds(events).length === 2)
    expect(turnEnds(events)[1]).not.toMatchObject({ discarded: true })
  })

  it('after an interrupt with no newer turn the suppressed result leaves the session idle', async () => {
    const sdk = stubSdk()
    const { session, stub } = await open(sdk)
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    await waitUntil(() => stub.received.length === 1)
    await session.interrupt()
    stub.push(result(stub.received[0]!.uuid, 0.001, 'error_during_execution'))
    await ticks(5)
    session.send({ id: 'E', text: 'E', mode: 'followup' })
    await waitUntil(() => stub.received.length === 2)
    expect(stub.received[1]!.message.content).toBe('E')
  })
})
