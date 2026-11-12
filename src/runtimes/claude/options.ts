/**
 * Maps a SessionSpec to the SDK Options: a whitelisted environment, the builtin tool sets, the fixed permission posture
 * (dontAsk, never bypass), the guard and read hooks, the worker-only Agent with the subagent guard
 * and the definitions of host-declared subagents with their read-only guard,
 * the sandbox and the limits.
 */
import type {
  AgentDefinition,
  Options,
  HookCallback,
  HookCallbackMatcher,
  McpServerConfig,
  SandboxSettings,
  Settings,
  SpawnOptions,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk'
import { existsSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path'
import type { SessionSpec, SubagentSpec } from '../../executor/contract.ts'
import { subprocessEnv, INHERITED_ENV } from '../../infra/env.ts'
import { mcpToolName } from './mcp.ts'

export type AuthMode = 'api-key' | 'subscription' | 'bedrock' | 'vertex'

export const AUTH_ENV: Record<AuthMode, readonly string[]> = {
  'api-key': ['ANTHROPIC_API_KEY'],
  subscription: ['CLAUDE_CODE_OAUTH_TOKEN'],
  bedrock: [
    'CLAUDE_CODE_USE_BEDROCK',
    'AWS_REGION',
    'AWS_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ],
  vertex: [
    'CLAUDE_CODE_USE_VERTEX',
    'CLOUD_ML_REGION',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ],
}

export const CLAUDE_INHERITED_ENV = [...INHERITED_ENV, 'USER', 'LOGNAME', 'SHELL', 'TMPDIR'] as const

export const ALWAYS_DISALLOWED = ['AskUserQuestion', 'WebFetch', 'WebSearch'] as const

export const AGENT_TOOL = 'Agent'
/** Built-in subagent types measured on SDK 0.3.321 / CLI 2.1.321; update when the pinned CLI changes. */
export const SUBAGENT_TYPES: readonly string[] = ['general-purpose', 'Explore', 'Plan'] as const
export const HOST_TOOL_PREFIX = mcpToolName('')

const AGENT_NOT_ALLOWED = 'Agent is not allowed in this session'
const SUBAGENT_ISOLATION = 'Subagent isolation is not allowed'
const SUBAGENT_NESTED = 'A subagent cannot start another subagent'
const SUBAGENT_HOST_TOOL = 'Host tools are only available to the main worker, not to subagents'
export const SUBAGENT_DISALLOWED = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  AGENT_TOOL,
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
] as const
const SUBAGENT_READ_ONLY = 'The reviewer may only read files and inspect git history'
const SUBAGENT_NOT_ADMITTED =
  'Review is not available now: call it only after orchestrator_publish returns review_required'

/** Turns off CLI commit and PR attribution through the flag settings layer; settingSources stays as it is. */
export const ATTRIBUTION_OFF = {
  attribution: { commit: '', pr: '', sessionUrl: false },
  includeCoAuthoredBy: false,
} as const satisfies Settings

export interface OptionsContext {
  mode: AuthMode
  env: Readonly<Record<string, string | undefined>>
  configDir: string
  sandbox: boolean
  /**
   * Linux only, skip the fresh /proc mount inside the sandbox. Also sets denyRead /proc.
   * CLI 0.3.321 binds /proc after that mask, so /proc stays visible;
   * other processes' environ reads were measured as denied.
   */
  weakerNestedSandbox?: boolean
  sessionId?: string
  mcp?: McpServerConfig
  onRead: () => void
  abortController: AbortController
  stderr?: (text: string) => void
  /**
   * security.trustRepoConfig: load the repository's project settings.
   * Repository MCP config stays ignored (strictMcpConfig).
   */
  trustRepoConfig?: boolean
  /** Called once per guard denial with the tool name and the fixed reason (never the command). */
  onDeny?: (tool: string, reason: string, agentId?: string) => void
  spawn?: (options: SpawnOptions) => SpawnedProcess
}

const READ_TOOLS = ['Read', 'Glob', 'Grep']
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']
const SHELL_TOOLS = ['Bash']
export const READONLY_GIT_RULES = [
  'Bash(git show:*)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git branch:*)',
  'Bash(git blame:*)',
  'Bash(git cat-file:*)',
  'Bash(git ls-files:*)',
  'Bash(git rev-parse:*)',
] as const

function isSecretName(key: string): boolean {
  if (Object.values(AUTH_ENV).some(keys => keys.includes(key))) return true
  if (/^(SUPERAGENT_CLAUDE_|GITHUB_|GH_)/.test(key)) return true
  if (/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(key)) return true
  return key === 'CLAUDE_CONFIG_DIR' || key === 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'
}

export function claudeEnv(
  spec: SessionSpec,
  ctx: Pick<OptionsContext, 'mode' | 'env' | 'configDir'>,
): Record<string, string> {
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
  if (builtins.shell) allowed.push(...SHELL_TOOLS, ...READONLY_GIT_RULES)
  if (!builtins.shell) disallowed.push(...SHELL_TOOLS)
  return { allowed, disallowed }
}

const OUTSIDE_CWD = 'Writing outside the working directory is not allowed'
const PUSH_OR_PR =
  'Push, pull requests and PR changes go through the orchestrator_publish, orchestrator_review_reply, orchestrator_pr_auto_merge and orchestrator_pr_close tools'
const PROC_READ = 'Reading /proc is not allowed'

function isProcPath(path: string): boolean {
  return path === '/proc' || path.startsWith('/proc/')
}

export function underProc(path: string): boolean {
  if (isProcPath(path)) return true
  let existing = path
  const rest: string[] = []
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing))
    existing = dirname(existing)
  }
  let resolved = existing
  try {
    resolved = realpathSync(existing)
  } catch {}
  return isProcPath(join(resolved, ...rest))
}

function canonical(path: string): string {
  let existing = path
  const rest: string[] = []
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing))
    existing = dirname(existing)
  }
  let real = existing
  try {
    real = realpathSync(existing)
  } catch {}
  return join(real, ...rest)
}

function globLiteralPrefix(pattern: string): string {
  const parts: string[] = []
  for (const segment of pattern.split('/')) {
    if (/[*?[{]/.test(segment)) break
    parts.push(segment)
  }
  return parts.join('/')
}

function subagentTypes(spec: SessionSpec): string[] {
  return [...SUBAGENT_TYPES, ...(spec.subagents ?? []).map(s => s.name)]
}

function subagentOf(spec: SessionSpec, type: unknown): SubagentSpec | undefined {
  return typeof type === 'string' ? spec.subagents?.find(s => s.name === type) : undefined
}

function permittedTools(sub: SubagentSpec): string[] {
  return [...(sub.tools === 'read' ? READ_TOOLS : []), ...sub.hostTools.map(t => mcpToolName(t))]
}

export function agentDefinitions(
  spec: SessionSpec,
  allowed: readonly string[],
): Record<string, AgentDefinition> | undefined {
  if (spec.role !== 'worker' || !spec.subagents?.length) return undefined
  return Object.fromEntries(
    spec.subagents.map(s => [
      s.name,
      {
        description: s.description,
        prompt: s.instructions,
        tools: permittedTools(s).filter(t => allowed.includes(t)),
        disallowedTools: [...SUBAGENT_DISALLOWED],
      },
    ]),
  )
}

export function agentResponseText(response: unknown): string {
  if (typeof response === 'string') return response
  if (typeof response !== 'object' || response === null || !('content' in response)) return ''
  const content = (response as { content: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .flatMap(item =>
        typeof (item as { text?: unknown } | null)?.text === 'string' ? [(item as { text: string }).text] : [],
      )
      .join('\n')
  return ''
}

export function guardDecision(
  spec: SessionSpec,
  toolName: string,
  input: unknown,
  agentId?: string,
  agentType?: string,
): string | undefined {
  const args = (input ?? {}) as Record<string, unknown>
  if (toolName === AGENT_TOOL) {
    if (spec.role !== 'worker') return AGENT_NOT_ALLOWED
    if (agentId !== undefined) return SUBAGENT_NESTED
    if (args.isolation !== undefined) return SUBAGENT_ISOLATION
    if (
      args.subagent_type !== undefined &&
      !(typeof args.subagent_type === 'string' && subagentTypes(spec).includes(args.subagent_type))
    )
      return `Only these subagent types are allowed: ${subagentTypes(spec).join(', ')}`
    return undefined
  }
  if (agentId !== undefined) {
    const sub = subagentOf(spec, agentType)
    if (sub) {
      if (!permittedTools(sub).includes(toolName)) return SUBAGENT_READ_ONLY
      if (toolName.startsWith(HOST_TOOL_PREFIX)) return undefined
    } else if (toolName.startsWith(HOST_TOOL_PREFIX)) return SUBAGENT_HOST_TOOL
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const path = toolName === 'NotebookEdit' ? args.notebook_path : args.file_path
    if (typeof path !== 'string') return 'A file path is required'
    const cwd = canonical(resolve(spec.cwd))
    const rel = relative(cwd, canonical(resolve(resolve(spec.cwd), path)))
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return OUTSIDE_CWD
    return undefined
  }
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
    const cwd = resolve(spec.cwd)
    const candidates: unknown[] = [toolName === 'Read' ? args.file_path : args.path]
    if (toolName === 'Glob' && typeof args.pattern === 'string') {
      const prefix = globLiteralPrefix(args.pattern)
      if (prefix !== '') candidates.push(prefix)
    }
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && underProc(resolve(cwd, candidate))) return PROC_READ
    }
    return undefined
  }
  if (toolName === 'Bash') {
    if (typeof args.command !== 'string') return undefined
    if (/\bgit\b[^\n;&|]*\bpush\b/.test(args.command) || /(^|[\s;&|()`$])gh(\s|$)/.test(args.command)) return PUSH_OR_PR
    return undefined
  }
  return undefined
}

export function foregroundInput(input: unknown): Record<string, unknown> {
  return { ...((input ?? {}) as Record<string, unknown>), run_in_background: false }
}

export function sdkOptions(spec: SessionSpec, ctx: OptionsContext): Options {
  const tools = builtinTools(spec.builtins)
  const allowed = [
    ...tools.allowed,
    ...(spec.role === 'worker' ? [AGENT_TOOL] : []),
    ...spec.tools.map(t => mcpToolName(t.name)),
  ]
  const agents = agentDefinitions(spec, allowed)
  const guard: HookCallback = async input => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const agentId =
      typeof (input as { agent_id?: unknown }).agent_id === 'string'
        ? (input as { agent_id: string }).agent_id
        : undefined
    const agentType =
      typeof (input as { agent_type?: unknown }).agent_type === 'string'
        ? (input as { agent_type: string }).agent_type
        : undefined
    const deny = (reason: string) => {
      try {
        agentId === undefined ? ctx.onDeny?.(input.tool_name, reason) : ctx.onDeny?.(input.tool_name, reason, agentId)
      } catch {}
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: reason,
        },
      }
    }
    const reason = guardDecision(spec, input.tool_name, input.tool_input, agentId, agentType)
    if (reason === undefined) {
      if (input.tool_name === AGENT_TOOL) {
        const sub =
          agentId === undefined
            ? subagentOf(spec, (input.tool_input as Record<string, unknown> | undefined)?.subagent_type)
            : undefined
        if (sub) {
          let admitted: { preamble: string } | undefined
          try {
            admitted = await sub.admit()
          } catch {
            admitted = undefined
          }
          if (!admitted) return deny(SUBAGENT_NOT_ADMITTED)
          const original = foregroundInput(input.tool_input)
          const prompt = typeof original.prompt === 'string' ? original.prompt : ''
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              updatedInput: { ...original, prompt: admitted.preamble + '\n\n' + prompt },
            },
          }
        }
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: foregroundInput(input.tool_input) } }
      }
      return {}
    }
    return deny(reason)
  }
  const read: HookCallback = async input => {
    if (typeof (input as { agent_id?: unknown }).agent_id === 'string') return {}
    ctx.onRead()
    return {}
  }
  const finished: HookCallback = async input => {
    if (
      input.hook_event_name !== 'PostToolUse' ||
      input.tool_name !== AGENT_TOOL ||
      typeof (input as { agent_id?: unknown }).agent_id === 'string'
    )
      return {}
    try {
      subagentOf(spec, (input.tool_input as Record<string, unknown> | undefined)?.subagent_type)?.finished?.(
        agentResponseText(input.tool_response),
      )
    } catch {}
    return {}
  }
  const preToolUse: HookCallbackMatcher = { hooks: [guard], onFailure: 'block' }
  const readMatcher: HookCallbackMatcher = { hooks: [read] }
  return {
    cwd: spec.cwd,
    env: claudeEnv(spec, ctx),
    settingSources: ctx.trustRepoConfig ? ['project'] : [],
    settings: { ...ATTRIBUTION_OFF, attribution: { ...ATTRIBUTION_OFF.attribution } },
    permissionMode: 'dontAsk',
    abortController: ctx.abortController,
    systemPrompt:
      spec.role === 'worker' ? { type: 'preset', preset: 'claude_code', append: spec.instructions } : spec.instructions,
    allowedTools: allowed,
    disallowedTools: spec.role === 'worker' ? tools.disallowed : [...tools.disallowed, AGENT_TOOL],
    canUseTool: async toolName => ({ behavior: 'deny', message: `${toolName} is not allowed in this session` }),
    mcpServers: ctx.mcp ? { superagent: ctx.mcp } : {},
    strictMcpConfig: true,
    ...(agents ? { agents } : {}),
    hooks: {
      PreToolUse: [preToolUse],
      UserPromptSubmit: [readMatcher],
      PostToolBatch: [readMatcher],
      ...(agents ? { PostToolUse: [{ matcher: AGENT_TOOL, hooks: [finished] }] } : {}),
    },
    ...(ctx.sandbox
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            autoAllowBashIfSandboxed: true,
            network: { allowedDomains: [...spec.network.allow] },
            ...(ctx.weakerNestedSandbox
              ? { enableWeakerNestedSandbox: true, filesystem: { denyRead: ['/proc'] } }
              : {}),
          } satisfies SandboxSettings,
        }
      : {}),
    maxTurns: spec.limits.maxTurns,
    maxBudgetUsd: spec.limits.maxBudgetUsd,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.resume ? { resume: spec.resume } : ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.stderr ? { stderr: ctx.stderr } : {}),
    ...(ctx.spawn ? { spawnClaudeCodeProcess: ctx.spawn } : {}),
  }
}
