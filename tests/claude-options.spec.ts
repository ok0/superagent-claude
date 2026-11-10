import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk'
import type { SessionSpec, ToolSpec } from '../src/executor/contract.ts'
import { AUTH_ENV, CLAUDE_INHERITED_ENV, ALWAYS_DISALLOWED, claudeEnv, builtinTools, guardDecision, sdkOptions, type AuthMode, type OptionsContext } from '../src/runtimes/claude/options.ts'
import { mcpTools, mcpServer, toolHandler } from '../src/runtimes/claude/mcp.ts'

const MODES: AuthMode[] = ['api-key', 'subscription', 'bedrock', 'vertex']

const reportTool: ToolSpec = { name: 'orchestrator_report', description: 'report', schema: z.object({}), execute: async () => ({ ok: true }) }

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    key: 'k',
    role: 'worker',
    cwd: '/work/t1',
    instructions: 'do the work',
    tools: [reportTool],
    builtins: { fs: 'write', shell: true, web: false },
    network: { allow: ['registry.npmjs.org'] },
    limits: { maxTurns: 7, maxBudgetUsd: 2.5 },
    env: { FOO: 'bar', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'x' },
    ...overrides,
  }
}

const SOURCE_ENV: Record<string, string> = {
  PATH: 'v-PATH',
  HOME: 'v-HOME',
  LANG: 'v-LANG',
  USER: 'v-USER',
  SHELL: 'v-SHELL',
  TMPDIR: 'v-TMPDIR',
  SUPERAGENT_CLAUDE_GITHUB_TOKEN: 'v-SUPERAGENT_CLAUDE_GITHUB_TOKEN',
  GITHUB_TOKEN: 'v-GITHUB_TOKEN',
  GH_TOKEN: 'v-GH_TOKEN',
  ANTHROPIC_API_KEY: 'v-ANTHROPIC_API_KEY',
  CLAUDE_CODE_OAUTH_TOKEN: 'v-CLAUDE_CODE_OAUTH_TOKEN',
  AWS_REGION: 'v-AWS_REGION',
  AWS_ACCESS_KEY_ID: 'v-AWS_ACCESS_KEY_ID',
  AWS_SECRET_ACCESS_KEY: 'v-AWS_SECRET_ACCESS_KEY',
  CLOUD_ML_REGION: 'v-CLOUD_ML_REGION',
  ANTHROPIC_VERTEX_PROJECT_ID: 'v-ANTHROPIC_VERTEX_PROJECT_ID',
  GOOGLE_APPLICATION_CREDENTIALS: 'v-GOOGLE_APPLICATION_CREDENTIALS',
  RANDOM_DAEMON_VAR: 'v-RANDOM_DAEMON_VAR',
}

function ctx(mode: AuthMode, overrides: Partial<OptionsContext> = {}): OptionsContext {
  return {
    mode,
    env: SOURCE_ENV,
    configDir: '/state/claude',
    sandbox: true,
    sessionId: '00000000-0000-4000-8000-000000000001',
    onRead: vi.fn(),
    abortController: new AbortController(),
    ...overrides,
  }
}

type HookFn = (input: unknown, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>
function hookFn(matchers: HookCallbackMatcher[] | undefined, index = 0): HookFn {
  return matchers![0]!.hooks[index] as unknown as HookFn
}

describe('fixed safety defaults', () => {
  it('fixed safety defaults hold for every spec combination', () => {
    const builtinsList: SessionSpec['builtins'][] = [
      { fs: 'none', shell: false, web: false },
      { fs: 'read', shell: false, web: false },
      { fs: 'write', shell: true, web: false },
    ]
    for (const mode of MODES) for (const builtins of builtinsList) for (const role of ['worker', 'router'] as const) for (const allow of [[], ['example.com']]) for (const resume of [undefined, 'S1']) {
      const options: Options = sdkOptions(spec({ builtins, role, network: { allow }, resume }), ctx(mode))
      expect(options.settingSources).toEqual([])
      expect(options.permissionMode).toBe('dontAsk')
      expect(JSON.stringify(options)).not.toContain('bypassPermissions')
      expect('allowDangerouslySkipPermissions' in options).toBe(false)
      expect(options.disallowedTools).toEqual(expect.arrayContaining(['AskUserQuestion', 'WebFetch', 'WebSearch']))
    }
  })

  it('builtins map to allowed and disallowed tools', () => {
    const read = sdkOptions(spec({ builtins: { fs: 'read', shell: false, web: false } }), ctx('api-key'))
    expect(read.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'NotebookEdit', 'Bash']))
    expect(read.allowedTools).toEqual(expect.arrayContaining(['Read']))

    const none = sdkOptions(spec({ builtins: { fs: 'none', shell: false, web: false } }), ctx('api-key'))
    expect(none.disallowedTools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep']))

    const write = sdkOptions(spec(), ctx('api-key'))
    expect(write.allowedTools).toContain('mcp__superagent__orchestrator_report')
    expect(builtinTools({ fs: 'write', shell: true, web: false }).allowed).toEqual(expect.arrayContaining(['Write', 'Edit', 'NotebookEdit', 'Bash']))
  })

  it('the guard hook blocks on failure and the read hooks are registered', async () => {
    const onRead = vi.fn()
    const options = sdkOptions(spec(), ctx('api-key', { onRead }))
    expect(options.hooks!.PreToolUse![0]!.onFailure).toBe('block')
    expect(options.hooks!.UserPromptSubmit).toHaveLength(1)
    expect(options.hooks!.PostToolBatch).toHaveLength(1)

    const signal = new AbortController().signal
    await hookFn(options.hooks!.UserPromptSubmit)({ hook_event_name: 'UserPromptSubmit', prompt: '' }, undefined, { signal })
    await hookFn(options.hooks!.PostToolBatch)({ hook_event_name: 'PostToolBatch' }, undefined, { signal })
    expect(onRead).toHaveBeenCalledTimes(2)
  })

  it('the guard denies writes outside cwd and direct push', async () => {
    const s = spec()
    expect(guardDecision(s, 'Write', { file_path: '/etc/x' })).toBeDefined()
    expect(guardDecision(s, 'Write', { file_path: 'src/a.ts' })).toBeUndefined()
    expect(guardDecision(s, 'Write', { file_path: '../t2/a' })).toBeDefined()
    expect(guardDecision(s, 'Bash', { command: 'git push origin HEAD' })).toBeDefined()
    expect(guardDecision(s, 'Bash', { command: 'gh pr create' })).toBeDefined()
    expect(guardDecision(s, 'Bash', { command: 'git commit -m x' })).toBeUndefined()

    const options = sdkOptions(s, ctx('api-key'))
    const out = (await hookFn(options.hooks!.PreToolUse)({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/etc/x' } }, undefined, { signal: new AbortController().signal })) as {
      hookSpecificOutput?: { permissionDecision?: string }
    }
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
  })

  it.each(MODES)('env is a whitelist with only the selected mode\'s credentials (%s)', mode => {
    const env = claudeEnv(spec(), ctx(mode))
    const allowedKeys = new Set<string>([...CLAUDE_INHERITED_ENV, 'FOO', ...AUTH_ENV[mode], 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'])
    for (const key of Object.keys(env)) expect(allowedKeys.has(key)).toBe(true)
    for (const other of MODES) {
      if (other === mode) continue
      for (const key of AUTH_ENV[other]) {
        if (AUTH_ENV[mode].includes(key)) continue
        expect(key in env).toBe(false)
      }
    }
    expect('SUPERAGENT_CLAUDE_GITHUB_TOKEN' in env).toBe(false)
    expect('GITHUB_TOKEN' in env).toBe(false)
    expect('GH_TOKEN' in env).toBe(false)
    expect('RANDOM_DAEMON_VAR' in env).toBe(false)
    expect(env.CLAUDE_CONFIG_DIR).toBe('/state/claude')
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    if (mode === 'api-key') {
      expect(env.ANTHROPIC_API_KEY).toBe('v-ANTHROPIC_API_KEY')
    }
    if (mode === 'subscription') {
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeDefined()
      expect('ANTHROPIC_API_KEY' in env).toBe(false)
    }
    if (mode === 'bedrock') {
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
      expect(env.AWS_REGION).toBeDefined()
    }
    if (mode === 'vertex') {
      expect(env.CLAUDE_CODE_USE_VERTEX).toBe('1')
      expect(env.ANTHROPIC_VERTEX_PROJECT_ID).toBeDefined()
    }
  })

  it('the sandbox maps the network allow list', () => {
    const on = sdkOptions(spec(), ctx('api-key'))
    expect(on.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: ['registry.npmjs.org'] } })
    const off = sdkOptions(spec(), ctx('api-key', { sandbox: false }))
    expect(off.sandbox).toBeUndefined()
  })

  it('limits, model, resume and session id are mapped', () => {
    const base = sdkOptions(spec({ model: 'haiku' }), ctx('api-key'))
    expect(base.maxTurns).toBe(7)
    expect(base.maxBudgetUsd).toBe(2.5)
    expect(base.model).toBe('haiku')
    expect(base.sessionId).toBe('00000000-0000-4000-8000-000000000001')
    expect(base.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'do the work' })

    const resumed = sdkOptions(spec({ resume: 'S1' }), ctx('api-key'))
    expect(resumed.resume).toBe('S1')
    expect(resumed.sessionId).toBeUndefined()

    const router = sdkOptions(spec({ role: 'router' }), ctx('api-key'))
    expect(router.systemPrompt).toBe('do the work')
  })

  it('mcp tool names match the ToolSpecs and calls reach execute', async () => {
    const signal = new AbortController().signal
    const reported: unknown[] = []
    const reportSpec: ToolSpec = {
      name: 'report',
      description: 'report',
      schema: z.object({ state: z.string(), summary: z.string() }),
      execute: async args => {
        reported.push(args)
        return { ok: true }
      },
    }
    const waitSpec: ToolSpec = { name: 'wait', description: 'wait', schema: z.object({}), execute: async () => 'waited' }
    const tools = [waitSpec, reportSpec]
    expect(mcpTools(tools, signal).map(t => t.name)).toEqual(['wait', 'report'])

    const result = await toolHandler(reportSpec, signal)({ state: 'ready', summary: 'done' })
    expect(result.isError).toBeFalsy()
    expect(reported).toEqual([{ state: 'ready', summary: 'done' }])

    const failing: ToolSpec = { name: 'boom', description: 'boom', schema: z.object({}), execute: async () => { throw new Error('nope') } }
    expect(await toolHandler(failing, signal)({})).toEqual({ isError: true, content: [{ type: 'text', text: 'nope' }] })

    const server = mcpServer(tools, signal)
    expect(server.type).toBe('sdk')
    expect(server.name).toBe('superagent')
  })

  it('the always-disallowed list is part of every session', () => {
    expect([...ALWAYS_DISALLOWED]).toEqual(['AskUserQuestion', 'WebFetch', 'WebSearch'])
  })
})
