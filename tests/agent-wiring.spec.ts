/**
 * The agent choice for start: the Claude runtime with git workspaces or the fake runtime with scratch directories, the adapter env per auth mode, and the executor tools exposed to worker sessions.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentEnv, createAgent } from '../src/app/agent.ts'
import { ConfigSchema } from '../src/app/config.ts'
import { resolveCredential } from '../src/app/credentials.ts'
import { Runtime } from '../src/app/runtime.ts'
import { MCP_TOOL_PREFIX, WORKER_TOOLS } from '../src/app/tool-names.ts'
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
  SUPERAGENT_CLAUDE_GITHUB_TOKEN: 'gh',
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
  return ConfigSchema.parse({ repositories: ['owner/repo'], policy: { allowed: ['alice'], acceptMode: 'auto' }, auth: { mode }, stateDir: join(dir!, 'state') })
}

describe('agent wiring', () => {
  it('selects the Claude runtime with git workspaces without fake, and the fake runtime with scratch directories with it', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    const config = cfg('api-key')
    const claude = createAgent({ config, credential: resolveCredential('api-key', ALL), env: ALL })
    expect(claude.runtime).toBeInstanceOf(ClaudeRuntime)
    expect(claude.runtime.id).toBe('claude')
    expect(claude.workspaces).toBe('git')
    expect(existsSync(join(config.stateDir, 'claude'))).toBe(true)

    const fake = createAgent({ config, credential: resolveCredential('api-key', ALL), env: ALL, fake: () => ({}) })
    expect(fake.runtime).toBeInstanceOf(FakeRuntime)
    expect(fake.workspaces).toBe('scratch')
  })

  it.each(MODES)('the %s adapter env carries only that mode\'s variables', async mode => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    const credential = resolveCredential(mode, ALL)
    const env = agentEnv(credential, ALL)
    const others = MODES.filter(other => other !== mode).flatMap(other => AUTH_ENV[other]).filter(key => !AUTH_ENV[mode].includes(key))
    expect(Object.keys(env).every(key => [...CLAUDE_INHERITED_ENV, ...AUTH_ENV[mode]].includes(key))).toBe(true)
    for (const key of AUTH_ENV[mode]) if (key in ALL) expect(env[key]).toBe(ALL[key])
    if (mode === 'bedrock') expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    if (mode === 'vertex') expect(env.CLAUDE_CODE_USE_VERTEX).toBe('1')
    for (const key of others) expect(env[key]).toBeUndefined()
    expect(env.SUPERAGENT_CLAUDE_GITHUB_TOKEN).toBeUndefined()

    const sdk = stubSdk()
    const agent = createAgent({ config: cfg(mode), credential, env: ALL, query: sdk.query })
    const session = await agent.runtime.open(contractSpec('followup starts a new turn').spec)
    const sdkEnv = sdk.queries[0]!.options.env as Record<string, string | undefined>
    for (const key of AUTH_ENV[mode]) if (key in ALL) expect(sdkEnv[key]).toBe(ALL[key])
    for (const key of others) expect(sdkEnv[key]).toBeUndefined()
    expect(sdkEnv.SUPERAGENT_CLAUDE_GITHUB_TOKEN).toBeUndefined()
    await session.close()
  })

  it('worker sessions expose the executor tools through the superagent MCP server', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wiring-'))
    const sdk = stubSdk()
    const config = { ...cfg('api-key'), models: { worker: 'claude-test-model' } }
    const chat = testSource()
    runtime = new Runtime({ config, runtime: createAgent({ config, credential: resolveCredential('api-key', ALL), env: ALL, query: sdk.query }).runtime, kinds: [chat.kind], services: [chat.service] })
    await runtime.start()
    chat.emit(trigger('1', { addressed: 'mention', meta: { repository: 'owner/repo' } }))
    await waitUntil(() => sdk.queries.length === 1)
    const options = sdk.queries[0]!.options
    expect(Object.keys(options.mcpServers!)).toEqual(['superagent'])
    const LATER = ['orchestrator_read', 'orchestrator_publish']  // M14, M16
    expect(options.allowedTools!.filter(t => t.startsWith(MCP_TOOL_PREFIX)).sort()).toEqual(WORKER_TOOLS.filter(n => !LATER.includes(n)).map(n => MCP_TOOL_PREFIX + n).sort())
    expect(options.model).toBe('claude-test-model')
    expect((options.env as Record<string, string | undefined>).SUPERAGENT_CLAUDE_GITHUB_TOKEN).toBeUndefined()
  })
})
