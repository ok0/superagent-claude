import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { query, type HookCallbackMatcher, type Options, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import type { SessionSpec, ToolSpec } from '../src/executor/contract.ts'
import {
  AUTH_ENV,
  CLAUDE_INHERITED_ENV,
  ALWAYS_DISALLOWED,
  ATTRIBUTION_OFF,
  SUBAGENT_TYPES,
  claudeEnv,
  builtinTools,
  guardDecision,
  sdkOptions,
  underProc,
  type AuthMode,
  type OptionsContext,
} from '../src/runtimes/claude/options.ts'
import { mcpTools, mcpServer, mcpToolName, toolHandler } from '../src/runtimes/claude/mcp.ts'
import { WORKER_TOOLS } from '../src/app/tool-names.ts'

const MODES: AuthMode[] = ['api-key', 'subscription', 'bedrock', 'vertex']

const reportTool: ToolSpec = {
  name: 'orchestrator_report',
  description: 'report',
  schema: z.object({}),
  execute: async () => ({ ok: true }),
}

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
    for (const mode of MODES)
      for (const builtins of builtinsList)
        for (const role of ['worker', 'router'] as const)
          for (const allow of [[], ['example.com']])
            for (const resume of [undefined, 'S1']) {
              const options: Options = sdkOptions(spec({ builtins, role, network: { allow }, resume }), ctx(mode))
              expect(options.settingSources).toEqual([])
              expect(options.settings).toEqual(ATTRIBUTION_OFF)
              expect(options.permissionMode).toBe('dontAsk')
              expect(JSON.stringify(options)).not.toContain('bypassPermissions')
              expect('allowDangerouslySkipPermissions' in options).toBe(false)
              expect(options.disallowedTools).toEqual(
                expect.arrayContaining(['AskUserQuestion', 'WebFetch', 'WebSearch']),
              )
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
    expect(builtinTools({ fs: 'write', shell: true, web: false }).allowed).toEqual(
      expect.arrayContaining(['Write', 'Edit', 'NotebookEdit', 'Bash']),
    )
  })

  it('the guard hook blocks on failure and the read hooks are registered', async () => {
    const onRead = vi.fn()
    const options = sdkOptions(spec(), ctx('api-key', { onRead }))
    expect(options.hooks!.PreToolUse![0]!.onFailure).toBe('block')
    expect(options.hooks!.UserPromptSubmit).toHaveLength(1)
    expect(options.hooks!.PostToolBatch).toHaveLength(1)

    const signal = new AbortController().signal
    await hookFn(options.hooks!.UserPromptSubmit)({ hook_event_name: 'UserPromptSubmit', prompt: '' }, undefined, {
      signal,
    })
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
    for (const command of ['git push origin HEAD', 'gh pr create']) {
      const message = guardDecision(s, 'Bash', { command })!
      const names = [...message.matchAll(/orchestrator_[a-z_]+/g)].map(match => match[0])
      expect(names.length).toBeGreaterThan(0)
      for (const name of names) expect(WORKER_TOOLS).toContain(name)
    }

    const options = sdkOptions(s, ctx('api-key'))
    const out = (await hookFn(options.hooks!.PreToolUse)(
      { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/etc/x' } },
      undefined,
      { signal: new AbortController().signal },
    )) as {
      hookSpecificOutput?: { permissionDecision?: string }
    }
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
  })

  it.each(MODES)("env is a whitelist with only the selected mode's credentials (%s)", mode => {
    const env = claudeEnv(spec(), ctx(mode))
    const allowedKeys = new Set<string>([
      ...CLAUDE_INHERITED_ENV,
      'FOO',
      ...AUTH_ENV[mode],
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    ])
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
    expect(on.sandbox).toMatchObject({
      enabled: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ['registry.npmjs.org'] },
    })
    const off = sdkOptions(spec(), ctx('api-key', { sandbox: false }))
    expect(off.sandbox).toBeUndefined()
  })

  it('weakerNestedSandbox maps to enableWeakerNestedSandbox only when set', () => {
    const on = sdkOptions(spec(), ctx('api-key', { weakerNestedSandbox: true })).sandbox as Record<string, unknown>
    expect(on).toMatchObject({
      enableWeakerNestedSandbox: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    })
    const def = sdkOptions(spec(), ctx('api-key')).sandbox as Record<string, unknown>
    expect(on.filesystem).toEqual({ denyRead: ['/proc'] })
    expect('enableWeakerNestedSandbox' in def).toBe(false)
    expect('filesystem' in def).toBe(false)
    const off = sdkOptions(spec(), ctx('api-key', { sandbox: false, weakerNestedSandbox: true }))
    expect(off.sandbox).toBeUndefined()
  })

  it('the write guard compares canonical paths for a symlinked cwd and denies symlinks that escape', () => {
    const base = mkdtempSync(join(tmpdir(), 'guard-canon-'))
    try {
      const realdir = join(base, 'real')
      mkdirSync(realdir)
      const linkParent = join(base, 'parent')
      mkdirSync(linkParent)
      const link = join(linkParent, 'link')
      symlinkSync(realdir, link)
      const outside = join(base, 'outside')
      mkdirSync(outside)
      const s = spec({ cwd: link })
      expect(guardDecision(s, 'Edit', { file_path: join(link, 'a.ts') })).toBeUndefined()
      expect(guardDecision(s, 'Edit', { file_path: join(realdir, 'a.ts') })).toBeUndefined()
      expect(guardDecision(s, 'Edit', { file_path: join(realdir, '..', 'x') })).toBeDefined()
      expect(guardDecision(s, 'Write', { file_path: '/tmp/x' })).toBeDefined()
      symlinkSync(outside, join(realdir, 'escape'))
      expect(guardDecision(s, 'Write', { file_path: join(realdir, 'escape', 'a.ts') })).toBeDefined()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('the guard denies the file tools under /proc', () => {
    const s = spec()
    const denied: [string, Record<string, unknown>][] = [
      ['Read', { file_path: '/proc/1/environ' }],
      ['Read', { file_path: '/proc' }],
      ['Grep', { pattern: 'TOKEN', path: '/proc/self' }],
      ['Glob', { pattern: '/proc/*/environ' }],
      ['Glob', { pattern: '*', path: '/proc/1' }],
    ]
    for (const [tool, input] of denied) expect(guardDecision(s, tool, input)).toBe('Reading /proc is not allowed')
    const dir = mkdtempSync(join(tmpdir(), 'guard-proc-'))
    try {
      symlinkSync('/proc', join(dir, 'p'))
      const link = join(dir, 'p', '1', 'environ')
      if (existsSync('/proc/1'))
        expect(guardDecision(s, 'Read', { file_path: link })).toBe('Reading /proc is not allowed')
      else expect(typeof underProc(link)).toBe('boolean')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const allowed: [string, Record<string, unknown>][] = [
      ['Read', { file_path: 'src/a.ts' }],
      ['Read', { file_path: '/etc/hosts' }],
      ['Grep', { pattern: 'x' }],
      ['Glob', { pattern: '**/*.ts' }],
      ['Read', { file_path: '/procfs/x' }],
    ]
    for (const [tool, input] of allowed) expect(guardDecision(s, tool, input)).toBeUndefined()
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
    const waitSpec: ToolSpec = {
      name: 'wait',
      description: 'wait',
      schema: z.object({}),
      execute: async () => 'waited',
    }
    const tools = [waitSpec, reportSpec]
    expect(mcpTools(tools, signal).map(t => t.name)).toEqual(['wait', 'report'])

    const result = await toolHandler(reportSpec, signal)({ state: 'ready', summary: 'done' })
    expect(result.isError).toBeFalsy()
    expect(reported).toEqual([{ state: 'ready', summary: 'done' }])

    const failing: ToolSpec = {
      name: 'boom',
      description: 'boom',
      schema: z.object({}),
      execute: async () => {
        throw new Error('nope')
      },
    }
    expect(await toolHandler(failing, signal)({})).toEqual({ isError: true, content: [{ type: 'text', text: 'nope' }] })

    const server = mcpServer(tools, signal)
    expect(server.type).toBe('sdk')
    expect(server.name).toBe('superagent')
  })

  it('the shell worker allows the nine read-only git rules and no broad git or push rule', () => {
    const nine = [
      'Bash(git show:*)',
      'Bash(git log:*)',
      'Bash(git diff:*)',
      'Bash(git status:*)',
      'Bash(git branch:*)',
      'Bash(git blame:*)',
      'Bash(git cat-file:*)',
      'Bash(git ls-files:*)',
      'Bash(git rev-parse:*)',
    ]
    const allowed = sdkOptions(spec(), ctx('api-key')).allowedTools!
    for (const rule of nine) expect(allowed).toContain(rule)
    expect(allowed).not.toContain('Bash(git:*)')
    expect(allowed.filter(entry => /push/.test(entry))).toEqual([])
    const readOnly = builtinTools({ fs: 'read', shell: false, web: false }).allowed
    for (const rule of nine) expect(readOnly).not.toContain(rule)
  })

  it('the guard hook denies push and gh variants with one onDeny call each and allows read-only git', async () => {
    const signal = new AbortController().signal
    const denied = [
      'git push origin HEAD:main',
      'git push --force',
      'cd sub && git push',
      '(git push)',
      'gh pr merge 1',
      'gh api repos/x',
    ]
    for (const command of denied) {
      const onDeny = vi.fn()
      const options = sdkOptions(spec(), ctx('api-key', { onDeny }))
      const out = (await hookFn(options.hooks!.PreToolUse)(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          session_id: 's',
          transcript_path: '',
          cwd: '/work/t1',
          tool_use_id: 'u',
        },
        'u',
        { signal },
      )) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
      }
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(onDeny).toHaveBeenCalledTimes(1)
      expect(onDeny).toHaveBeenCalledWith('Bash', out.hookSpecificOutput!.permissionDecisionReason)
      expect(out.hookSpecificOutput!.permissionDecisionReason).not.toContain(command)
    }
    for (const command of ['git show b:f', 'git log -1', 'git diff']) {
      const onDeny = vi.fn()
      const options = sdkOptions(spec(), ctx('api-key', { onDeny }))
      const out = await hookFn(options.hooks!.PreToolUse)(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          session_id: 's',
          transcript_path: '',
          cwd: '/work/t1',
          tool_use_id: 'u',
        },
        'u',
        { signal },
      )
      expect(out).toEqual({})
      expect(onDeny).not.toHaveBeenCalled()
    }
  })

  it('the always-disallowed list is part of every session', () => {
    expect([...ALWAYS_DISALLOWED]).toEqual(['AskUserQuestion', 'WebFetch', 'WebSearch'])
  })

  it('trustRepoConfig loads only the project settings and keeps repository MCP config off', () => {
    const trusted = sdkOptions(spec(), ctx('subscription', { trustRepoConfig: true }))
    expect(trusted.settingSources).toEqual(['project'])
    expect(trusted.strictMcpConfig).toBe(true)
    expect(trusted.permissionMode).toBe('dontAsk')

    const untrusted = sdkOptions(spec(), ctx('subscription', { trustRepoConfig: false }))
    expect(untrusted.settingSources).toEqual([])
    expect(sdkOptions(spec(), ctx('subscription')).settingSources).toEqual([])
  })

  it('keeps the attribution-off settings when the repository config is trusted', () => {
    const trusted = sdkOptions(spec(), ctx('api-key', { trustRepoConfig: true }))
    expect(trusted.settingSources).toEqual(['project'])
    expect(trusted.settings).toEqual(ATTRIBUTION_OFF)
  })

  it('the SDK hands the attribution-off settings to the CLI as --settings with the sandbox and empty setting sources', async () => {
    let resolve!: (args: string[]) => void
    const captured = new Promise<string[]>(r => {
      resolve = r
    })
    const abortController = new AbortController()
    const children: ChildProcess[] = []
    const options = sdkOptions(
      spec(),
      ctx('api-key', {
        abortController,
        sandbox: true,
        spawn: o => {
          resolve(o.args)
          const child = nodeSpawn(process.execPath, ['-e', 'process.stdin.resume()'], {
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          children.push(child)
          return child as unknown as SpawnedProcess
        },
      }),
    )
    try {
      const q = query({ prompt: 'x', options })
      void q.next().catch(() => {})
      const args = await Promise.race([
        captured,
        new Promise<never>((_, r) => setTimeout(() => r(new Error('no spawn')), 10000)),
      ])
      expect(args).toContain('--setting-sources=')
      const i = args.indexOf('--settings')
      expect(i).toBeGreaterThanOrEqual(0)
      const parsed = JSON.parse(args[i + 1]!)
      expect(parsed.attribution).toEqual({ commit: '', pr: '', sessionUrl: false })
      expect(parsed.includeCoAuthoredBy).toBe(false)
      expect(parsed.sandbox.enabled).toBe(true)
    } finally {
      abortController.abort()
      for (const child of children) child.kill('SIGKILL')
    }
  }, 15000)
})

describe('subagents', () => {
  const hookInput = (tool_name: string, tool_input: unknown, agent_id?: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
    session_id: 's',
    transcript_path: 't',
    cwd: '/work/t1',
    tool_use_id: 'u',
    ...(agent_id !== undefined ? { agent_id } : {}),
  })

  it('worker allows Agent and router disallows it', () => {
    const worker = sdkOptions(spec(), ctx('api-key'))
    expect(worker.allowedTools).toContain('Agent')
    expect(worker.disallowedTools).not.toContain('Agent')

    const router = sdkOptions(
      spec({ role: 'router', builtins: { fs: 'none', shell: false, web: false } }),
      ctx('api-key'),
    )
    expect(router.disallowedTools).toContain('Agent')
    expect(router.allowedTools).not.toContain('Agent')
  })

  it('no custom agents, bypass or web tools in any mapping', () => {
    const builtinsList: SessionSpec['builtins'][] = [
      { fs: 'none', shell: false, web: false },
      { fs: 'read', shell: false, web: false },
      { fs: 'write', shell: true, web: false },
    ]
    for (const mode of MODES)
      for (const builtins of builtinsList)
        for (const role of ['worker', 'router'] as const) {
          const options = sdkOptions(spec({ builtins, role }), ctx(mode))
          expect('agents' in options).toBe(false)
          expect(JSON.stringify(options)).not.toContain('bypassPermissions')
          expect(options.disallowedTools).toEqual(expect.arrayContaining(['AskUserQuestion', 'WebFetch', 'WebSearch']))
        }
  })

  it('one env and the parent permission set', () => {
    const s = spec()
    const options = sdkOptions(
      s,
      ctx('subscription', { env: { ...SOURCE_ENV, SUPERAGENT_CLAUDE_GITHUB_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'k' } }),
    )
    expect(options.env).toBeDefined()
    expect('SUPERAGENT_CLAUDE_GITHUB_TOKEN' in options.env!).toBe(false)
    expect('ANTHROPIC_API_KEY' in options.env!).toBe(false)
    expect(Object.keys(options).some(key => key.toLowerCase().includes('agent'))).toBe(false)
    expect(options.allowedTools!.filter(t => t !== 'Agent')).toEqual([
      ...builtinTools(s.builtins).allowed,
      ...s.tools.map(t => mcpToolName(t.name)),
    ])
    expect(options.disallowedTools).toEqual(builtinTools(s.builtins).disallowed)
  })

  it('Agent type, isolation and nesting', () => {
    const worker = spec()
    const router = spec({ role: 'router', builtins: { fs: 'none', shell: false, web: false } })
    expect(guardDecision(worker, 'Agent', { prompt: 'p', description: 'd' })).toBeUndefined()
    for (const type of SUBAGENT_TYPES)
      expect(guardDecision(worker, 'Agent', { prompt: 'p', description: 'd', subagent_type: type })).toBeUndefined()
    const typeReason = guardDecision(worker, 'Agent', { prompt: 'p', description: 'd', subagent_type: 'repo-reviewer' })
    expect(typeReason).toContain('Only these subagent types')
    expect(guardDecision(worker, 'Agent', { prompt: 'p', description: 'd', isolation: 'worktree' })).toBe(
      'Subagent isolation is not allowed',
    )
    expect(guardDecision(worker, 'Agent', { prompt: 'p', description: 'd', isolation: 'remote' })).toBe(
      'Subagent isolation is not allowed',
    )
    expect(guardDecision(worker, 'Agent', { prompt: 'p', description: 'd' }, 'a1')).toBe(
      'A subagent cannot start another subagent',
    )
    expect(guardDecision(router, 'Agent', { prompt: 'p', description: 'd' })).toBe(
      'Agent is not allowed in this session',
    )
  })

  it('host tools are denied inside subagents only', async () => {
    const signal = new AbortController().signal
    const s = spec()
    for (const tool of ['mcp__superagent__orchestrator_report', 'mcp__superagent__orchestrator_publish']) {
      expect(guardDecision(s, tool, { status: 'waiting', human_action: { kind: 'x' } }, 'a1')).toBe(
        'Host tools are only available to the main worker, not to subagents',
      )
      expect(guardDecision(s, tool, { status: 'waiting', human_action: { kind: 'x' } })).toBeUndefined()
    }

    const onDeny = vi.fn()
    const options = sdkOptions(s, ctx('api-key', { onDeny }))
    const out = (await hookFn(options.hooks!.PreToolUse)(
      hookInput('mcp__superagent__orchestrator_report', {}, 'a1'),
      'u',
      { signal },
    )) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
    }
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBe(
      'Host tools are only available to the main worker, not to subagents',
    )
    expect(onDeny).toHaveBeenCalledTimes(1)
    expect(onDeny).toHaveBeenCalledWith(
      'mcp__superagent__orchestrator_report',
      'Host tools are only available to the main worker, not to subagents',
      'a1',
    )

    const workerDeny = vi.fn()
    const workerOptions = sdkOptions(s, ctx('api-key', { onDeny: workerDeny }))
    await hookFn(workerOptions.hooks!.PreToolUse)(hookInput('Bash', { command: 'git push origin main' }), 'u', {
      signal,
    })
    expect(workerDeny).toHaveBeenCalledTimes(1)
    expect(workerDeny.mock.calls[0]).toHaveLength(2)
  })

  it("subagent tool calls get the parent's rules", () => {
    const s = spec()
    const calls: [string, Record<string, unknown>][] = [
      ['Write', { file_path: '/etc/x' }],
      ['Bash', { command: 'git push origin main' }],
      ['Bash', { command: 'gh pr list' }],
      ['Read', { file_path: '/proc/1/environ' }],
    ]
    for (const [tool, input] of calls) {
      expect(guardDecision(s, tool, input, 'a1')).toEqual(guardDecision(s, tool, input))
      expect(guardDecision(s, tool, input, 'a1')).toBeDefined()
    }
  })

  it('Agent is forced to the foreground', async () => {
    const signal = new AbortController().signal
    const options = sdkOptions(spec(), ctx('api-key'))
    const forced = (await hookFn(options.hooks!.PreToolUse)(
      hookInput('Agent', { prompt: 'p', description: 'd', run_in_background: true }),
      'u',
      { signal },
    )) as {
      hookSpecificOutput?: { updatedInput?: unknown; permissionDecision?: string }
    }
    expect(forced.hookSpecificOutput?.updatedInput).toEqual({ prompt: 'p', description: 'd', run_in_background: false })
    expect(forced.hookSpecificOutput?.permissionDecision).toBeUndefined()

    for (const tool_input of [
      { prompt: 'p', description: 'd' },
      { prompt: 'p', description: 'd', run_in_background: false },
    ]) {
      const out = (await hookFn(options.hooks!.PreToolUse)(hookInput('Agent', tool_input), 'u', { signal })) as {
        hookSpecificOutput?: { updatedInput?: unknown; permissionDecision?: string }
      }
      expect(out.hookSpecificOutput?.updatedInput).toEqual({ prompt: 'p', description: 'd', run_in_background: false })
      expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined()
    }

    expect(
      guardDecision(spec(), 'Agent', {
        prompt: 'p',
        description: 'd',
        run_in_background: true,
        model: 'opus',
        effort: 'high',
      }),
    ).toBeUndefined()
  })

  it('read hooks ignore subagent signals', async () => {
    const signal = new AbortController().signal
    const onRead = vi.fn()
    const options = sdkOptions(spec(), ctx('api-key', { onRead }))
    await hookFn(options.hooks!.PostToolBatch)(
      {
        hook_event_name: 'PostToolBatch',
        tool_calls: [],
        agent_id: 'a1',
        session_id: 's',
        transcript_path: 't',
        cwd: '/work/t1',
      },
      undefined,
      { signal },
    )
    expect(onRead).not.toHaveBeenCalled()
    await hookFn(options.hooks!.PostToolBatch)(
      { hook_event_name: 'PostToolBatch', tool_calls: [], session_id: 's', transcript_path: 't', cwd: '/work/t1' },
      undefined,
      { signal },
    )
    expect(onRead).toHaveBeenCalledTimes(1)
  })
})
