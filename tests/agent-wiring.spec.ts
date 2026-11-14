/**
 * The agent choice for start: the Claude runtime with git workspaces or the fake runtime with scratch
 * directories, the adapter env per auth mode, and the executor tools exposed to worker sessions.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentEnv, createAgent, toolDeniedRecord } from '../src/app/agent.ts'
import type { LogRecord } from '../src/sources/host.ts'
import { ConfigSchema } from '../src/app/config.ts'
import { resolveCredential } from '../src/app/credentials.ts'
import { Runtime } from '../src/app/runtime.ts'
import { MCP_TOOL_PREFIX, ROUTER_TOOLS, WORKER_TOOLS } from '../src/app/tool-names.ts'
import type { AgentRuntime, SessionSpec } from '../src/executor/contract.ts'
import { AUTH_ENV, CLAUDE_INHERITED_ENV, type AuthMode } from '../src/runtimes/claude/options.ts'
import { ClaudeRuntime } from '../src/runtimes/claude/runtime.ts'
import { FakeRuntime } from '../src/runtimes/fake/runtime.ts'
import { waitUntil } from './fixtures/async.ts'
import { stubSdk } from './fixtures/claude-sdk-stub.ts'
import { trigger } from './fixtures/engine.ts'
import { contractSpec } from './fixtures/runtime-contract.ts'
import { testSource } from './fixtures/source.ts'

const ALL: Record<string, string> = {
  PATH: '/bin',
  HOME: '/home/t',
  ANTHROPIC_API_KEY: 'k',
  CLAUDE_CODE_OAUTH_TOKEN: 'o',
  AWS_REGION: 'r',
  AWS_PROFILE: 'p',
  AWS_ACCESS_KEY_ID: 'a',
  AWS_SECRET_ACCESS_KEY: 's',
  AWS_SESSION_TOKEN: 't',
  CLOUD_ML_REGION: 'c',
  ANTHROPIC_VERTEX_PROJECT_ID: 'v',
  GOOGLE_APPLICATION_CREDENTIALS: '/g',
  ISSUECREW_GITHUB_TOKEN: 'gh',
}

const MODES: AuthMode[] = ['api-key', 'subscription', 'bedrock', 'vertex']

let dir: string | undefined
let runtime: Runtime | undefined

afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function cfg(mode: AuthMode) {
  return ConfigSchema.parse({
    repositories: ['owner/repo'],
    policy: { allowed: ['alice'], acceptMode: 'auto' },
    auth: { mode },
    stateDir: join(dir!, 'state'),
  })
}

describe('agent wiring', () => {
  it('selects the Claude runtime with git workspaces without fake, and the fake runtime with scratch directories with it', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    const config = cfg('api-key')
    const claude = createAgent({ config, credential: resolveCredential('api-key', ALL), env: ALL })
    expect(claude.runtime).toBeInstanceOf(ClaudeRuntime)
    expect(claude.runtime.id).toBe('claude')
    expect(claude.workspaces).toBe('git')
    expect(claude.router).toBe('session')
    expect(existsSync(join(config.stateDir, 'claude'))).toBe(true)

    const fake = createAgent({ config, credential: resolveCredential('api-key', ALL), env: ALL, fake: () => ({}) })
    expect(fake.runtime).toBeInstanceOf(FakeRuntime)
    expect(fake.workspaces).toBe('scratch')
    expect(fake.router).toBe('deterministic')
  })

  it.each(MODES)("the %s adapter env carries only that mode's variables", async mode => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    const credential = resolveCredential(mode, ALL)
    const env = agentEnv(credential, ALL)
    const others = MODES.filter(other => other !== mode)
      .flatMap(other => AUTH_ENV[other])
      .filter(key => !AUTH_ENV[mode].includes(key))
    expect(Object.keys(env).every(key => [...CLAUDE_INHERITED_ENV, ...AUTH_ENV[mode]].includes(key))).toBe(true)
    for (const key of AUTH_ENV[mode]) if (key in ALL) expect(env[key]).toBe(ALL[key])
    if (mode === 'bedrock') expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    if (mode === 'vertex') expect(env.CLAUDE_CODE_USE_VERTEX).toBe('1')
    for (const key of others) expect(env[key]).toBeUndefined()
    expect(env.ISSUECREW_GITHUB_TOKEN).toBeUndefined()

    const sdk = stubSdk()
    const agent = createAgent({ config: cfg(mode), credential, env: ALL, query: sdk.query })
    const session = await agent.runtime.open(contractSpec('followup starts a new turn').spec)
    const sdkEnv = sdk.queries[0]!.options.env as Record<string, string | undefined>
    for (const key of AUTH_ENV[mode]) if (key in ALL) expect(sdkEnv[key]).toBe(ALL[key])
    for (const key of others) expect(sdkEnv[key]).toBeUndefined()
    expect(sdkEnv.ISSUECREW_GITHUB_TOKEN).toBeUndefined()
    await session.close()
  })

  it('security.trustRepoConfig reaches the SDK settingSources', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    for (const trust of [false, true]) {
      const sdk = stubSdk()
      const base = cfg('subscription')
      const config = { ...base, security: { ...base.security, trustRepoConfig: trust } }
      const agent = createAgent({
        config,
        credential: resolveCredential('subscription', ALL),
        env: ALL,
        query: sdk.query,
      })
      const session = await agent.runtime.open(contractSpec('followup starts a new turn').spec)
      expect(sdk.queries[0]!.options.settingSources).toEqual(trust ? ['project'] : [])
      await session.close()
    }
  })

  it('security.weakerNestedSandbox reaches the SDK sandbox', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    for (const weaker of [false, true]) {
      const sdk = stubSdk()
      const base = cfg('subscription')
      const config = { ...base, security: { ...base.security, weakerNestedSandbox: weaker } }
      const agent = createAgent({
        config,
        credential: resolveCredential('subscription', ALL),
        env: ALL,
        query: sdk.query,
      })
      const session = await agent.runtime.open(contractSpec('followup starts a new turn').spec)
      expect(sdk.queries[0]!.options.sandbox?.enableWeakerNestedSandbox).toBe(weaker ? true : undefined)
      expect(sdk.queries[0]!.options.sandbox?.filesystem?.denyRead).toEqual(weaker ? ['/proc'] : undefined)
      await session.close()
    }
  })

  it('security.allowLocalBinding reaches the SDK sandbox', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    expect(cfg('subscription').security.allowLocalBinding).toBe(true)
    for (const value of [false, true]) {
      const sdk = stubSdk()
      const base = cfg('subscription')
      const config = { ...base, security: { ...base.security, allowLocalBinding: value } }
      const agent = createAgent({
        config,
        credential: resolveCredential('subscription', ALL),
        env: ALL,
        query: sdk.query,
      })
      const session = await agent.runtime.open(contractSpec('followup starts a new turn').spec)
      expect(sdk.queries[0]!.options.sandbox?.network?.allowLocalBinding).toBe(value)
      expect(sdk.queries[0]!.options.sandbox?.network?.allowedDomains).toEqual([
        ...contractSpec('followup starts a new turn').spec.network.allow,
      ])
      await session.close()
    }
  })

  it('a guard denial is logged as worker.tool_denied without the command', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    const sdk = stubSdk()
    const logs: LogRecord[] = []
    const agent = createAgent({
      config: cfg('api-key'),
      credential: resolveCredential('api-key', ALL),
      env: ALL,
      query: sdk.query,
      log: r => logs.push(r),
    })
    const session = await agent.runtime.open(
      contractSpec('followup starts a new turn', {
        key: 'worker-t1',
        builtins: { fs: 'write', shell: true, web: false },
      }).spec,
    )
    await sdk.queries[0]!.hook('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin HEAD:main' },
    })
    const denials = logs.filter(r => r.event === 'worker.tool_denied')
    expect(logs).toHaveLength(1)
    expect(denials).toHaveLength(1)
    expect(denials[0]).toMatchObject({ event: 'worker.tool_denied', level: 'warn', ticketId: 't1', tool: 'Bash' })
    expect('agentId' in denials[0]!).toBe(false)
    const serialized = JSON.stringify(logs)
    expect(serialized).not.toContain('HEAD:main')
    expect(serialized).not.toContain('git push origin')
    await session.close()
  })

  it('a subagent guard denial is logged with agentId', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    const sdk = stubSdk()
    const logs: LogRecord[] = []
    const agent = createAgent({
      config: cfg('api-key'),
      credential: resolveCredential('api-key', ALL),
      env: ALL,
      query: sdk.query,
      log: r => logs.push(r),
    })
    const session = await agent.runtime.open(
      contractSpec('followup starts a new turn', {
        key: 'worker-t1',
        builtins: { fs: 'write', shell: true, web: false },
      }).spec,
    )
    await sdk.queries[0]!.hook('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin HEAD:main' },
      agent_id: 'a1',
    })
    const denials = logs.filter(r => r.event === 'worker.tool_denied')
    expect(logs).toHaveLength(1)
    expect(denials).toHaveLength(1)
    expect(denials[0]).toMatchObject({ ticketId: 't1', tool: 'Bash', agentId: 'a1' })
    const serialized = JSON.stringify(logs)
    expect(serialized).not.toContain('HEAD:main')
    await session.close()
  })

  it('the tool_denied record carries agentId only for subagent denials', () => {
    expect(
      toolDeniedRecord({ key: 'worker-t1', tool: 'Bash', reason: 'r', agentId: 'a1' }, '2026-01-01T00:00:00Z'),
    ).toMatchObject({ event: 'worker.tool_denied', ticketId: 't1', tool: 'Bash', reason: 'r', agentId: 'a1' })
    expect('agentId' in toolDeniedRecord({ key: 'worker-t1', tool: 'Bash', reason: 'r' }, '2026-01-01T00:00:00Z')).toBe(
      false,
    )
  })

  it('worker sessions expose the executor tools through the issuecrew MCP server', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    const sdk = stubSdk()
    const config = { ...cfg('api-key'), models: { worker: 'claude-test-model' } }
    const chat = testSource()
    runtime = new Runtime({
      config,
      runtime: createAgent({ config, credential: resolveCredential('api-key', ALL), env: ALL, query: sdk.query })
        .runtime,
      kinds: [chat.kind],
      services: [chat.service],
    })
    await runtime.start()
    chat.emit(trigger('1', { addressed: 'mention', meta: { repository: 'owner/repo' } }))
    await waitUntil(() => sdk.queries.length === 1)
    const options = sdk.queries[0]!.options
    expect(Object.keys(options.mcpServers!)).toEqual(['issuecrew'])
    expect(options.allowedTools!.filter(t => t.startsWith(MCP_TOOL_PREFIX)).sort()).toEqual(
      WORKER_TOOLS.map(n => MCP_TOOL_PREFIX + n).sort(),
    )
    expect(options.model).toBe('claude-test-model')
    expect((options.env as Record<string, string | undefined>).ISSUECREW_GITHUB_TOKEN).toBeUndefined()
  })

  it('the Claude start opens the Router session with the Router tools and no stand-in', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    const sdk = stubSdk()
    const config = cfg('subscription')
    const agent = createAgent({
      config,
      credential: resolveCredential('subscription', ALL),
      env: ALL,
      query: sdk.query,
    })
    const specs: SessionSpec[] = []
    const spy: AgentRuntime = {
      id: agent.runtime.id,
      probe: () => agent.runtime.probe(),
      open: spec => {
        specs.push(spec)
        return agent.runtime.open(spec)
      },
    }
    const chat = testSource()
    runtime = new Runtime({ config, runtime: spy, router: agent.router, kinds: [chat.kind], services: [chat.service] })
    await runtime.start()
    const router = sdk.queries[0]!
    const options = router.options
    expect(options.cwd).toBe(join(config.stateDir, 'router'))
    expect(options.allowedTools!.filter(t => t.startsWith(MCP_TOOL_PREFIX)).sort()).toEqual(
      ROUTER_TOOLS.map(n => MCP_TOOL_PREFIX + n).sort(),
    )
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch']),
    )
    expect(typeof options.systemPrompt).toBe('string')
    expect((options.systemPrompt as string).startsWith('## Host rules')).toBe(true)
    const env = options.env as Record<string, string | undefined>
    const others = (['api-key', 'bedrock', 'vertex'] as const)
      .flatMap(mode => AUTH_ENV[mode])
      .filter(key => !AUTH_ENV.subscription.includes(key))
    for (const key of AUTH_ENV.subscription) if (key in ALL) expect(env[key]).toBe(ALL[key])
    for (const key of others) expect(env[key]).toBeUndefined()
    expect(env.ISSUECREW_GITHUB_TOKEN).toBeUndefined()

    chat.emit(trigger('1', { addressed: 'mention', meta: { repository: 'owner/repo' } }))
    await waitUntil(() => router.received.length >= 1)
    const routeTool = specs
      .find(spec => spec.role === 'router')!
      .tools.find(tool => tool.name === 'orchestrator_route')!
    await routeTool.execute(
      {
        decisions: [
          { kind: 'accept', trigger_id: '1', title: 'Fix', worktree_name: 'fix-it', acknowledgement: 'On it.' },
        ],
      },
      new AbortController().signal,
    )
    await waitUntil(() => specs.some(spec => spec.role === 'worker'))
    const worker = specs.find(spec => spec.role === 'worker')!
    expect(worker.tools.map(tool => tool.name).sort()).toEqual([...WORKER_TOOLS].sort())
    const report = worker.tools.find(tool => tool.name === 'orchestrator_report')!
    await report.execute({ state: 'ready', summary: 'Done' }, new AbortController().signal)
    await waitUntil(() => router.received.some(message => JSON.stringify(message).includes('worker_report')))
    await runtime.outbox.sent()
    expect(chat.sent.some(message => message.text === 'Done')).toBe(false)
  })
})
