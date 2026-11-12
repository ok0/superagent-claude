import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { SessionSpec } from '../../../src/executor/contract.ts'
import { sdkOptions } from '../../../src/runtimes/claude/options.ts'
import type { ItemResult, SpikeContext, SpikeItem } from '../lib/types.ts'
import { isMain } from '../lib/types.ts'
import { baseOptions, compact, field, runScenario } from '../lib/session.ts'

const META = { id: 'readonly-git', req: 'readonly-git', title: '읽기 전용 git 명령 권한' }

const RULES = [
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

const COMMANDS = [
  'git show notes-draft:NOTES.md',
  'git log -1 --oneline notes-draft',
  'git cat-file -p notes-draft:NOTES.md',
  'git diff main notes-draft --stat',
  'git blame README.md',
]

const FIRST_MESSAGE =
  'Run each of these shell commands with the Bash tool, one Bash call per command, exactly as written, in this order, and use no other tool: (1) git show notes-draft:NOTES.md (2) git log -1 --oneline notes-draft (3) git cat-file -p notes-draft:NOTES.md (4) git diff main notes-draft --stat (5) git blame README.md. After the last one reply exactly DONE.'

const INSTRUCTIONS = 'Follow the user message exactly.'

const GIT_IDENTITY = ['-c', 'user.name=spike', '-c', 'user.email=spike@example.invalid', '-c', 'commit.gpgsign=false']

type Source = 'canUseTool' | 'cli-permission' | 'sandbox' | 'none'
type Outcome = 'A' | 'B' | 'C' | 'D'

interface VariantSpec {
  id: string
  cwd: string
  sandbox: boolean
  rules: boolean
}

interface Probe {
  id: string
  n: number
  command: string
  toolUse: boolean
  error: boolean
  recorded: boolean
  guarded: boolean
  text: string
  source: Source
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function yn(value: boolean): string {
  return value ? 'y' : 'n'
}

function commandOf(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input)
    if (typeof parsed === 'object' && parsed !== null) {
      const command = (parsed as { command?: unknown }).command
      if (typeof command === 'string') return command
    }
  } catch {
    return ''
  }
  return ''
}

function classify(recorded: boolean, error: boolean, text: string): Source {
  if (recorded) return 'canUseTool'
  if (!error) return 'none'
  if (/doesn't want to proceed|permission|not allowed/i.test(text)) return 'cli-permission'
  return 'sandbox'
}

function fixture(ctx: SpikeContext): { origin: string; worktree: string } {
  const origin = ctx.newRepo('rg-origin')
  git(origin, ['branch', '-M', 'main'])
  writeFileSync(join(origin, 'README.md'), 'line one\nline two\n')
  git(origin, ['add', '-A'])
  git(origin, ['commit', '-m', 'init'])
  git(origin, ['checkout', '-b', 'notes-draft'])
  writeFileSync(join(origin, 'NOTES.md'), 'Version 2 starts faster.\n')
  git(origin, ['add', '-A'])
  git(origin, ['commit', '-m', 'notes'])
  git(origin, ['checkout', 'main'])
  const tmpRoot = dirname(dirname(origin))
  const worktree = join(tmpRoot, 'worktrees', 't1')
  mkdirSync(dirname(worktree), { recursive: true })
  git(origin, ['worktree', 'add', worktree, '-b', 'agent/t1', 'main'])
  return { origin, worktree }
}

function buildOptions(
  ctx: SpikeContext,
  variant: VariantSpec,
): { options: Options; canUseCalls: { name: string; command: string }[]; guardHits: string[] } {
  const spec: SessionSpec = {
    key: 'worker-spike',
    role: 'worker',
    cwd: variant.cwd,
    instructions: INSTRUCTIONS,
    tools: [],
    builtins: { fs: 'write', shell: true, web: false },
    network: { allow: [] },
    limits: { maxTurns: 14, maxBudgetUsd: 0.25 },
    env: {},
    model: ctx.model,
  }
  const prod = sdkOptions(spec, {
    mode: ctx.auth.mode,
    env: ctx.sdkEnv(),
    configDir: ctx.configDir,
    sandbox: variant.sandbox,
    onRead: () => {},
    abortController: new AbortController(),
  })
  const options = baseOptions(ctx, variant.cwd, { ...prod, allowDangerouslySkipPermissions: false })

  const canUseCalls: { name: string; command: string }[] = []
  const inner = options.canUseTool!
  options.canUseTool = async (name, input, o) => {
    canUseCalls.push({ name, command: String((input as { command?: unknown }).command ?? '') })
    return inner(name, input, o)
  }

  const guardHits: string[] = []
  const matcher = options.hooks!.PreToolUse![0]!
  const original = matcher.hooks[0]!
  matcher.hooks = [
    async (input, toolUseId, hookOptions) => {
      const out = await original(input, toolUseId, hookOptions)
      const decision = (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision
      if (decision === 'deny') {
        guardHits.push(String((input as { tool_input?: { command?: unknown } }).tool_input?.command ?? ''))
      }
      return out
    },
  ]

  if (variant.rules) options.allowedTools!.push(...RULES)
  return { options, canUseCalls, guardHits }
}

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const { origin, worktree } = fixture(ctx)
  const variants: VariantSpec[] = [
    { id: 'V0', cwd: worktree, sandbox: true, rules: false },
    { id: 'V1', cwd: worktree, sandbox: true, rules: true },
    { id: 'V2', cwd: origin, sandbox: true, rules: false },
    { id: 'V3', cwd: worktree, sandbox: false, rules: false },
  ]

  const observations: string[] = []
  const evidence: string[] = []
  const costs: number[][] = []
  const probes = new Map<string, Probe[]>()
  let cliVersion = 'unknown'

  for (const variant of variants) {
    const built = buildOptions(ctx, variant)
    if (built.options.permissionMode !== 'dontAsk') {
      return {
        ...META,
        status: 'FAIL',
        deviation: false,
        summary: 'posture',
        observations: [`${variant.id} permissionMode=${String(built.options.permissionMode)}`],
        evidence,
        attempts: 0,
        costs,
      }
    }

    const outcome = await runScenario({
      ctx,
      options: built.options,
      first: { text: FIRST_MESSAGE },
      onEntry: (e, c) => {
        if (e.type === 'result') c.end()
      },
    })
    costs.push(outcome.costs)
    evidence.push(...outcome.timeline.map(e => `[${variant.id}] ${compact(e)}`))
    const version = field(outcome.init, 'claude_code_version')
    if (typeof version === 'string') cliVersion = version

    const uses = outcome.timeline.flatMap(e => (e.toolUses ?? []).map(u => ({ id: u.id, command: commandOf(u.input) })))
    const results = outcome.timeline.flatMap(e => e.toolResults ?? [])
    const variantProbes: Probe[] = COMMANDS.map((command, index) => {
      const use = uses.find(u => u.command === command)
      const result = use === undefined ? undefined : results.find(r => r.toolUseId === use.id)
      const recorded = built.canUseCalls.some(c => c.command === command)
      const guarded = built.guardHits.includes(command)
      const error = result?.isError === true
      const text = result?.content ?? ''
      return {
        id: variant.id,
        n: index + 1,
        command,
        toolUse: use !== undefined,
        error,
        recorded,
        guarded,
        text,
        source: classify(recorded, error, text),
      }
    })
    probes.set(variant.id, variantProbes)
    for (const p of variantProbes) {
      observations.push(
        `${p.id}/${p.n} tool_use=${yn(p.toolUse)} error=${yn(p.error)} canUseTool=${yn(p.recorded)} guard=${yn(p.guarded)} source=${p.source} result=${JSON.stringify(p.text.slice(0, 160))}`,
      )
    }
  }

  const v0 = probes.get('V0') ?? []
  const v1 = probes.get('V1') ?? []
  const v0Reproduces = v0[0] !== undefined && v0[0].source !== 'none'
  const v1Denials = v1.filter(p => p.source !== 'none')

  let outcome: Outcome
  let status: 'PASS' | 'FAIL'
  let deviation: boolean
  if (v1Denials.length > 0) {
    outcome = v1Denials.some(p => p.source === 'canUseTool') ? 'C' : 'D'
    status = 'FAIL'
    deviation = false
  } else if (v0Reproduces) {
    outcome = 'A'
    status = 'PASS'
    deviation = false
  } else {
    outcome = 'B'
    status = 'PASS'
    deviation = true
  }

  observations.unshift(
    `cliVersion=${cliVersion}`,
    `model=${ctx.model}`,
    `authMode=${ctx.auth.mode}`,
    `V0 command1 source=${v0[0]?.source ?? 'none'}`,
    `V1 denials=${v1Denials.length}`,
    `outcome=${outcome}`,
  )

  const summary = `outcome ${outcome}: V0 reproduces=${v0Reproduces}, V1 denials=${v1Denials.length} (${v1Denials.map(p => p.source).join(',') || 'none'})`

  return {
    ...META,
    status,
    deviation,
    summary,
    observations,
    evidence,
    attempts: variants.length,
    costs,
  }
}

export const item: SpikeItem = { ...META, adrs: 'readonly-git', live: true, estimateUsd: 0.6, run }

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
