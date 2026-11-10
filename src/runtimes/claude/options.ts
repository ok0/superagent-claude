/** Maps a SessionSpec to the SDK Options: a whitelisted environment, the builtin tool sets, the fixed permission posture (dontAsk, never bypass), the guard and read hooks, the sandbox and the limits. */
import type { Options, HookCallback, HookCallbackMatcher, McpServerConfig, SandboxSettings } from '@anthropic-ai/claude-agent-sdk'
import { resolve, relative, isAbsolute } from 'node:path'
import type { SessionSpec } from '../../executor/contract.ts'
import { subprocessEnv, INHERITED_ENV } from '../../infra/env.ts'
import { mcpToolName } from './mcp.ts'

export type AuthMode = 'api-key' | 'subscription' | 'bedrock' | 'vertex'

export const AUTH_ENV: Record<AuthMode, readonly string[]> = {
  'api-key': ['ANTHROPIC_API_KEY'],
  subscription: ['CLAUDE_CODE_OAUTH_TOKEN'],
  bedrock: ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  vertex: ['CLAUDE_CODE_USE_VERTEX', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'GOOGLE_APPLICATION_CREDENTIALS'],
}

export const CLAUDE_INHERITED_ENV = [...INHERITED_ENV, 'USER', 'LOGNAME', 'SHELL', 'TMPDIR'] as const

export const ALWAYS_DISALLOWED = ['AskUserQuestion', 'WebFetch', 'WebSearch'] as const

export interface OptionsContext {
  mode: AuthMode
  env: Readonly<Record<string, string | undefined>>
  configDir: string
  sandbox: boolean
  sessionId?: string
  mcp?: McpServerConfig
  onRead: () => void
  abortController: AbortController
  stderr?: (text: string) => void
}

const READ_TOOLS = ['Read', 'Glob', 'Grep']
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']
const SHELL_TOOLS = ['Bash']

function isSecretName(key: string): boolean {
  if (Object.values(AUTH_ENV).some(keys => keys.includes(key))) return true
  if (/^(SUPERAGENT_CLAUDE_|GITHUB_|GH_)/.test(key)) return true
  if (/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(key)) return true
  return key === 'CLAUDE_CONFIG_DIR' || key === 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'
}

export function claudeEnv(spec: SessionSpec, ctx: Pick<OptionsContext, 'mode' | 'env' | 'configDir'>): Record<string, string> {
  const base = subprocessEnv(ctx.env)
  for (const key of CLAUDE_INHERITED_ENV) {
    const value = ctx.env[key]
    if (typeof value === 'string') base[key] = value
  }
  const explicit: Record<string, string> = {}
  for (const [key, value] of Object.entries(spec.env)) {
    if (!isSecretName(key)) explicit[key] = value
  }
  const auth: Record<string, string> = {}
  for (const key of AUTH_ENV[ctx.mode]) {
    const value = ctx.env[key]
    if (typeof value === 'string') auth[key] = value
  }
  if (ctx.mode === 'bedrock') auth.CLAUDE_CODE_USE_BEDROCK = '1'
  if (ctx.mode === 'vertex') auth.CLAUDE_CODE_USE_VERTEX = '1'
  return { ...base, ...explicit, ...auth, CLAUDE_CONFIG_DIR: ctx.configDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
}

export function builtinTools(builtins: SessionSpec['builtins']): { allowed: string[]; disallowed: string[] } {
  const allowed: string[] = []
  const disallowed: string[] = [...ALWAYS_DISALLOWED]
  if (builtins.fs !== 'none') allowed.push(...READ_TOOLS)
  if (builtins.fs === 'none') disallowed.push(...READ_TOOLS)
  if (builtins.fs === 'write') allowed.push(...WRITE_TOOLS)
  if (builtins.fs !== 'write') disallowed.push(...WRITE_TOOLS)
  if (builtins.shell) allowed.push(...SHELL_TOOLS)
  if (!builtins.shell) disallowed.push(...SHELL_TOOLS)
  return { allowed, disallowed }
}

const OUTSIDE_CWD = 'Writing outside the working directory is not allowed'
const PUSH_OR_PR = 'Push and pull requests go through the orchestrator_publish tool'

export function guardDecision(spec: SessionSpec, toolName: string, input: unknown): string | undefined {
  const args = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const path = toolName === 'NotebookEdit' ? args.notebook_path : args.file_path
    if (typeof path !== 'string') return 'A file path is required'
    const cwd = resolve(spec.cwd)
    const rel = relative(cwd, resolve(cwd, path))
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return OUTSIDE_CWD
    return undefined
  }
  if (toolName === 'Bash') {
    if (typeof args.command !== 'string') return undefined
    if (/\bgit\b[^\n;&|]*\bpush\b/.test(args.command) || /(^|[\s;&|()`$])gh(\s|$)/.test(args.command)) return PUSH_OR_PR
    return undefined
  }
  return undefined
}

export function sdkOptions(spec: SessionSpec, ctx: OptionsContext): Options {
  const tools = builtinTools(spec.builtins)
  const guard: HookCallback = async input => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const reason = guardDecision(spec, input.tool_name, input.tool_input)
    if (reason === undefined) return {}
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
  }
  const read: HookCallback = async () => {
    ctx.onRead()
    return {}
  }
  const preToolUse: HookCallbackMatcher = { hooks: [guard], onFailure: 'block' }
  const readMatcher: HookCallbackMatcher = { hooks: [read] }
  return {
    cwd: spec.cwd,
    env: claudeEnv(spec, ctx),
    settingSources: [],
    permissionMode: 'dontAsk',
    abortController: ctx.abortController,
    systemPrompt: spec.role === 'worker' ? { type: 'preset', preset: 'claude_code', append: spec.instructions } : spec.instructions,
    allowedTools: [...tools.allowed, ...spec.tools.map(t => mcpToolName(t.name))],
    disallowedTools: tools.disallowed,
    canUseTool: async toolName => ({ behavior: 'deny', message: `${toolName} is not allowed in this session` }),
    mcpServers: ctx.mcp ? { superagent: ctx.mcp } : {},
    strictMcpConfig: true,
    hooks: { PreToolUse: [preToolUse], UserPromptSubmit: [readMatcher], PostToolBatch: [readMatcher] },
    ...(ctx.sandbox
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            autoAllowBashIfSandboxed: true,
            network: { allowedDomains: [...spec.network.allow] },
          } satisfies SandboxSettings,
        }
      : {}),
    maxTurns: spec.limits.maxTurns,
    maxBudgetUsd: spec.limits.maxBudgetUsd,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.resume ? { resume: spec.resume } : ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.stderr ? { stderr: ctx.stderr } : {}),
  }
}
