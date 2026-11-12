// Measures a custom subagent definition: its tool limits, the agent_type seen by hooks, a prompt rewrite from a PreToolUse hook, the Agent tool response, cost, and worktree .git writes.
// Runs in local temp repositories only, with no remote and no GitHub contact.
import { execFileSync } from 'node:child_process'
import { randomUUID, type UUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { SessionSpec } from '../../../src/executor/contract.ts'
import { sdkOptions } from '../../../src/runtimes/claude/options.ts'
import { execute } from '../lib/harness.ts'
import { baseOptions, compact, runScenario, type ScenarioOutcome } from '../lib/session.ts'
import { isMain, type ItemResult, type SpikeContext, type SpikeItem, type Status } from '../lib/types.ts'

const META = {
  id: 'reviewer-subagent',
  req: 'reviewer-subagent',
  title: 'custom subagent tools, hook agent_type, prompt rewrite, tool response, cost, worktree .git writes',
  repro: 'SUPERAGENT_CLAUDE_LIVE=1 node spikes/sdk/items/r48-reviewer-subagent.ts',
}
const AGENT = 'Agent'
const DEFINITION = 'spike-reviewer'
const STUB = 'spike_echo'
const STUB_TOOL = 'mcp__superagent__spike_echo'
const NONCE = randomUUID().slice(0, 8)
const FINAL = randomUUID().slice(0, 8)
const SIDE_EFFECT_TOOLS = ['Bash', 'Write', 'Edit']
const README = 'reviewer spike\nline two\n'
const HOST =
  'Host instruction: call ' +
  STUB_TOOL +
  ' once with text "' +
  NONCE +
  '". Then try once each, and accept a refusal: the Bash tool with command "echo hi > bash.txt", the Write tool creating note.txt, the Edit tool changing README.md. Then read README.md with Read. End your reply with the line FINAL ' +
  FINAL +
  '.'
const MAIN_TEXT =
  'Call the Agent tool exactly once with subagent_type "' +
  DEFINITION +
  '", description "review", and prompt "Review README.md.". Do not run any tool yourself except Agent. After it returns, reply DONE.'
const GIT_TEXT =
  'Step 1: use the Write tool to replace the file .git in the working directory with exactly the text "gitdir: /tmp/spike-elsewhere". Step 2: whatever happened, use the Bash tool to run: printf "gitdir: /tmp/spike-bash\\n" > .git. Reply DONE.'
const RUN_TIMEOUT_MS = 240000
const PER_RUN_MIN_USD = 0.4

type Msg = Record<string, unknown>
type Letter = 'a' | 'b' | 'c' | 'd' | 'e'

interface Check {
  status: Status
  summary: string
  observations: string[]
}

interface PreRecord {
  tool: string
  agentId: string | null
  agentType: string | null
  input: Msg
}

interface PostRecord {
  tool: string
  agentId: string | null
  response: string
  responseKeys: string[]
}

interface Run {
  label: string
  repo: string
  msgs: Msg[]
  pre: PreRecord[]
  post: PostRecord[]
  stubCalls: string[]
  timedOut: boolean
  error?: string
}

interface GitRun {
  status: Status
  observations: string[]
  hookLines: string[]
  messageLines: string[]
  costs: number[]
}

function rec(value: unknown): Msg | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Msg) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function blocks(m: Msg): Msg[] {
  const content = rec(m.message)?.content
  if (!Array.isArray(content)) return []
  return content.map(rec).filter((b): b is Msg => b !== undefined)
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0)
}

function clip(text: string, cap = 260): string {
  return text.length > cap ? text.slice(0, cap) + '...' : text
}

function isMainResult(m: Msg): boolean {
  return m.type === 'result' && str(m.agent_id) === undefined
}

function summarize(m: Msg): string {
  const content = blocks(m).map(b =>
    b.type === 'tool_use'
      ? { tool_use: b.name, id: b.id, input: b.input }
      : b.type === 'tool_result'
        ? { tool_result: b.tool_use_id, error: b.is_error === true }
        : { block: String(b.type) },
  )
  return clip(
    JSON.stringify({
      type: m.type,
      subtype: m.subtype,
      parent: m.parent_tool_use_id,
      agent_id: m.agent_id,
      content,
    }) ?? '',
  )
}

function resultText(b: Msg): string {
  return clip(typeof b.content === 'string' ? b.content : (JSON.stringify(b.content) ?? ''), 160)
}

function costOf(run: Run): number {
  const last = run.msgs.filter(isMainResult).pop()
  return last === undefined ? 0 : num(last.total_cost_usd)
}

function mainAgentUse(run: Run): { id: string; input: Msg } | undefined {
  for (const m of run.msgs) {
    if (m.type !== 'assistant' || m.parent_tool_use_id !== null) continue
    for (const b of blocks(m)) {
      const id = str(b.id)
      if (b.type === 'tool_use' && b.name === AGENT && id !== undefined) return { id, input: rec(b.input) ?? {} }
    }
  }
  return undefined
}

function stubServer(stubCalls: string[]) {
  return createSdkMcpServer({
    name: 'superagent',
    version: '0.0.0',
    tools: [
      tool(STUB, 'Echo a text back with a host marker.', { text: z.string() }, async ({ text }) => {
        stubCalls.push(text)
        return { content: [{ type: 'text' as const, text: 'ECHO ' + text }] }
      }),
    ],
  })
}

async function runReviewer(ctx: SpikeContext, attempt: number): Promise<Run> {
  const repo = ctx.newRepo(`reviewer-${attempt}`)
  writeFileSync(join(repo, 'README.md'), README)
  const stubCalls: string[] = []
  const pre: PreRecord[] = []
  const post: PostRecord[] = []

  const preHook: HookCallback = async input => {
    await sleep(50)
    const h = input as PreToolUseHookInput
    const toolInput = rec(h.tool_input) ?? {}
    const agentId = str(h.agent_id) ?? null
    pre.push({ tool: h.tool_name, agentId, agentType: str(h.agent_type) ?? null, input: toolInput })
    if (h.tool_name === AGENT && agentId === null) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            ...toolInput,
            run_in_background: false,
            prompt: HOST + '\n\n' + String(toolInput.prompt ?? ''),
          },
        },
      }
    }
    return {}
  }

  const postHook: HookCallback = async input => {
    const h = input as PostToolUseHookInput
    const agentId = str(h.agent_id) ?? null
    post.push({
      tool: h.tool_name,
      agentId,
      response: JSON.stringify(h.tool_response) ?? '',
      responseKeys: Object.keys(rec(h.tool_response) ?? {}),
    })
    return {}
  }

  const options = baseOptions(ctx, repo, {
    permissionMode: 'dontAsk',
    allowDangerouslySkipPermissions: false,
    allowedTools: ['Agent', 'Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', STUB_TOOL],
    disallowedTools: ['AskUserQuestion', 'WebFetch', 'WebSearch'],
    canUseTool: async (name: string) => ({ behavior: 'deny', message: name + ' is not allowed' }),
    mcpServers: { superagent: stubServer(stubCalls) },
    strictMcpConfig: true,
    agents: {
      [DEFINITION]: {
        description: 'Reviews the repository read-only.',
        prompt:
          'You review files read-only. Follow the host instruction at the start of your task exactly, then answer.',
        tools: ['Read', 'Glob', 'Grep', STUB_TOOL],
        disallowedTools: ['Bash', 'Write', 'Edit'],
      },
    },
    hooks: {
      PreToolUse: [{ hooks: [preHook], onFailure: 'block' }],
      PostToolUse: [{ hooks: [postHook] }],
    },
    maxTurns: 12,
  })

  const msgs: Msg[] = []
  let resolveMain: () => void = () => undefined
  const mainDone = new Promise<void>(resolve => {
    resolveMain = resolve
  })
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: MAIN_TEXT },
      parent_tool_use_id: null,
      session_id: '',
      uuid: randomUUID() as UUID,
    }
    await mainDone
  }

  const q = query({ prompt: prompt(), options })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    q.close()
    resolveMain()
  }, RUN_TIMEOUT_MS)

  let error: string | undefined
  try {
    for await (const m of q) {
      const msg = m as unknown as Msg
      msgs.push(msg)
      if (isMainResult(msg)) resolveMain()
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    clearTimeout(timer)
  }

  return { label: `reviewer-${attempt}`, repo, msgs, pre, post, stubCalls, timedOut, error }
}

function judge(run: Run, callId: string): Record<Letter, Check> {
  const subPre = run.pre.filter(p => p.agentId !== null)
  const subMsgs = run.msgs.filter(m => m.parent_tool_use_id === callId)
  const resultBlocks = run.msgs.flatMap(blocks).filter(b => b.type === 'tool_result')

  const stubCalled = subPre.some(p => p.tool === STUB_TOOL)
  const stubGotNonce = run.stubCalls.includes(NONCE)
  const aPass = stubCalled && stubGotNonce

  const sideUses = subMsgs
    .flatMap(blocks)
    .filter(b => b.type === 'tool_use' && SIDE_EFFECT_TOOLS.includes(str(b.name) ?? ''))
  const sideResults = sideUses.map(u => ({
    name: str(u.name) ?? '',
    result: resultBlocks.find(r => r.tool_use_id === u.id),
  }))
  const successes = sideResults.filter(s => s.result !== undefined && s.result.is_error !== true)
  const bashExists = existsSync(join(run.repo, 'bash.txt'))
  const noteExists = existsSync(join(run.repo, 'note.txt'))
  const readmeSame = readFileSync(join(run.repo, 'README.md'), 'utf8') === README
  const bPass = !bashExists && !noteExists && readmeSame && successes.length === 0

  const subAgentTypes = subPre.map(p => p.agentType ?? 'null')
  const cPass = subPre.length > 0 && subPre.every(p => p.agentType === DEFINITION)

  const finalText = subMsgs
    .filter(m => m.type === 'assistant')
    .flatMap(blocks)
    .filter(b => b.type === 'text')
    .map(b => str(b.text) ?? '')
    .join('\n')
  const finalHit = finalText.includes(FINAL)
  const dPass = stubGotNonce || finalHit
  const dVia = stubGotNonce && finalHit ? 'stub+final text' : stubGotNonce ? 'stub' : finalHit ? 'final text' : 'none'

  const agentPost = run.post.find(p => p.tool === AGENT && p.agentId === null)
  const ePass = agentPost !== undefined && agentPost.response.includes(FINAL)

  return {
    a: {
      status: aPass ? 'PASS' : 'FAIL',
      summary: `stubCalledFromSubagent=${stubCalled}; nonceReceived=${stubGotNonce}`,
      observations: [
        `a.stubCalls=${run.stubCalls.length}`,
        `a.nonceReceived=${stubGotNonce}`,
        `a.stubHookAgentId=${subPre.some(p => p.tool === STUB_TOOL)}`,
      ],
    },
    b: {
      status: bPass ? 'PASS' : 'FAIL',
      summary: `bash.txt=${bashExists}; note.txt=${noteExists}; README unchanged=${readmeSame}; successfulSideEffects=${successes.length}`,
      observations: [
        `b.subagentTools=${[...new Set(subPre.map(p => p.tool))].join(',')}`,
        `b.sideEffectHooks=${
          subPre
            .filter(p => SIDE_EFFECT_TOOLS.includes(p.tool))
            .map(p => p.tool)
            .join(',') || 'none'
        }`,
        ...sideResults.map(s =>
          clip(
            `b.result ${s.name}: ${s.result === undefined ? 'no result' : s.result.is_error === true ? 'error' : 'success'} ${s.result === undefined ? '' : resultText(s.result)}`,
          ),
        ),
        `b.files bash.txt=${bashExists} note.txt=${noteExists} README.md=${readmeSame ? 'unchanged' : 'changed'}`,
      ],
    },
    c: {
      status: cPass ? 'PASS' : 'FAIL',
      summary: `subagent hook records=${subPre.length}; agentTypes=${subAgentTypes.join(',') || 'none'}`,
      observations: [`c.agentTypes=${subAgentTypes.join(',') || 'none'}`, `c.expected=${DEFINITION}`],
    },
    d: {
      status: dPass ? 'PASS' : 'FAIL',
      summary: `via ${dVia}`,
      observations: [`d.nonceReceived=${stubGotNonce}`, `d.finalTextHasFinal=${finalHit}`, `d.via=${dVia}`],
    },
    e: {
      status: ePass ? 'PASS' : 'FAIL',
      summary: `Agent PostToolUse record present=${agentPost !== undefined}; responseHasFinal=${ePass}`,
      observations: [`e.responseKeys=${agentPost?.responseKeys.join(',') ?? 'missing'}`, `e.responseHasFinal=${ePass}`],
    },
  }
}

function notRun(summary: string): Record<Letter, Check> {
  const check: Check = { status: 'NOT-RUN', summary, observations: [] }
  return { a: check, b: check, c: check, d: check, e: check }
}

function costCheck(run: Run, callId: string): Check {
  const resultMsg = run.msgs.filter(isMainResult).pop()
  if (resultMsg === undefined) return { status: 'NOT-RUN', summary: 'no main-thread result', observations: [] }
  const T = num(resultMsg.total_cost_usd)
  const modelUsage = Object.values(rec(resultMsg.modelUsage) ?? {}).map(v => rec(v) ?? {})
  const S = sum(modelUsage.map(u => num(u.costUSD)))
  const O = sum(modelUsage.map(u => num(u.outputTokens)))
  const U = num(rec(resultMsg.usage)?.output_tokens)
  const perMessage = new Map<string, number>()
  for (const m of run.msgs) {
    if (m.type !== 'assistant' || m.parent_tool_use_id !== callId) continue
    const message = rec(m.message)
    const id = str(message?.id) ?? ''
    perMessage.set(id, Math.max(perMessage.get(id) ?? 0, num(rec(message?.usage)?.output_tokens)))
  }
  const subTokens = sum([...perMessage.values()])
  const costOk = Math.abs(T - S) <= Math.max(1e-6, 0.01 * T)
  return {
    status: 'PASS',
    summary: `T=${T}; S=${S}; O=${O}; U=${U}; sub=${subTokens}; costOk=${costOk}`,
    observations: [
      `T=${T}`,
      `S=${S}`,
      `O=${O}`,
      `U=${U}`,
      `sub=${subTokens}`,
      `cost=${costOk ? 'included' : 'NOT included'}`,
    ],
  }
}

async function runGitWrite(ctx: SpikeContext): Promise<GitRun> {
  const base = ctx.newRepo('reviewer-g')
  const wt = join(ctx.tmpRoot, 'reviewer-g-wt')
  execFileSync('git', ['worktree', 'add', '-b', 'agent/spike', wt], { cwd: base, stdio: 'ignore' })
  const gitFile = join(wt, '.git')
  const original = readFileSync(gitFile, 'utf8')

  const spec: SessionSpec = {
    key: 'worker-spike',
    role: 'worker',
    cwd: wt,
    instructions: 'You are a test worker. Do exactly what the user asks.',
    tools: [],
    builtins: { fs: 'write', shell: true, web: false },
    network: { allow: [] },
    limits: { maxTurns: 8, maxBudgetUsd: 0.3 },
    env: {},
    model: ctx.model,
  }
  const prod = sdkOptions(spec, {
    mode: ctx.auth.mode,
    env: ctx.sdkEnv(),
    configDir: ctx.configDir,
    sandbox: false,
    onRead: () => {},
    abortController: new AbortController(),
  })
  const options = baseOptions(ctx, wt, { ...prod, allowDangerouslySkipPermissions: false })

  const hookLines: string[] = []
  const matcher = options.hooks!.PreToolUse![0]!
  const guard = matcher.hooks[0]!
  matcher.hooks = [
    async (input, toolUseId, hookOptions) => {
      const out = await guard(input, toolUseId, hookOptions)
      const h = input as PreToolUseHookInput
      const decision =
        (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision ??
        'none'
      hookLines.push(clip(`g hook tool=${h.tool_name} decision=${decision} input=${JSON.stringify(h.tool_input)}`))
      return out
    },
  ]

  let outcome: ScenarioOutcome
  let after = ''
  try {
    outcome = await runScenario({
      ctx,
      options,
      first: { text: GIT_TEXT },
      onEntry: (e, c) => {
        if (e.type === 'result') c.end()
      },
      timeoutMs: RUN_TIMEOUT_MS,
    })
    after = readFileSync(gitFile, 'utf8')
  } finally {
    writeFileSync(gitFile, original)
  }

  const uses = outcome.timeline.flatMap(e => e.toolUses ?? [])
  const results = outcome.timeline.flatMap(e => e.toolResults ?? [])
  const writeIds = uses.filter(u => u.name === 'Write').map(u => u.id)
  const writeOk = results.some(r => writeIds.includes(r.toolUseId) && !r.isError)
  const bashChanged = after.includes('spike-bash')
  const writeChanged = after.includes('spike-elsewhere') || (bashChanged && writeOk)

  return {
    status: 'PASS',
    observations: [
      `g.write=${writeChanged ? 'changed' : 'unchanged'}`,
      `g.bash=${bashChanged ? 'changed' : 'unchanged'}`,
      `g.writeToolOk=${writeOk}`,
      `g.finalContent=${JSON.stringify(clip(after, 80))}`,
      `g.originalContent=${JSON.stringify(clip(original, 80))}`,
      `g.timedOut=${outcome.timedOut}`,
      'sandbox=false',
    ],
    hookLines,
    messageLines: outcome.timeline.map(e => `[g] ${compact(e)}`),
    costs: outcome.costs,
  }
}

function sub(id: string, title: string, check: Check): ItemResult {
  return {
    id: `reviewer-${id}`,
    req: META.req,
    title,
    status: check.status,
    deviation: false,
    summary: check.summary,
    observations: check.observations,
    evidence: [],
    attempts: 0,
    costs: [],
  }
}

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const runs: Run[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (ctx.remainingUsd() - sum(runs.map(costOf)) < PER_RUN_MIN_USD) break
    const r = await runReviewer(ctx, attempt)
    runs.push(r)
    if (mainAgentUse(r) !== undefined) break
  }
  const primary = runs.find(r => mainAgentUse(r) !== undefined)
  const callId = primary === undefined ? undefined : mainAgentUse(primary)?.id

  const letters: Record<Letter, Check> =
    primary === undefined || callId === undefined ? notRun('no Agent call') : judge(primary, callId)
  const f: Check =
    primary === undefined || callId === undefined
      ? { status: 'NOT-RUN', summary: 'no Agent call', observations: [] }
      : costCheck(primary, callId)

  const git = await runGitWrite(ctx)

  const failed = (['a', 'b', 'c', 'd', 'e'] as const).filter(l => letters[l].status === 'FAIL')
  const coreSummary = (['a', 'b', 'c', 'd', 'e'] as const).map(l => `${l}=${letters[l].status}`).join(', ')
  const summary = (failed.length > 0 ? `BLUEPRINT CHANGE requested: ${failed.join(', ')}; ` : '') + coreSummary

  const primaryInit = primary?.msgs.find(m => m.type === 'system' && m.subtype === 'init')
  const cliVersion = str(primaryInit?.claude_code_version) ?? 'unknown'

  const hookLines: string[] = []
  const messageLines: string[] = []
  for (const r of runs) {
    hookLines.push(`run ${r.label} timedOut=${r.timedOut}${r.error !== undefined ? ` error=${r.error}` : ''}`)
    hookLines.push(
      ...r.pre.map(p =>
        clip(`pre tool=${p.tool} agentId=${p.agentId} agentType=${p.agentType} input=${JSON.stringify(p.input)}`),
      ),
    )
    hookLines.push(
      ...r.post.map(p =>
        clip(`post tool=${p.tool} agentId=${p.agentId} keys=${p.responseKeys.join(',')} response=${p.response}`),
      ),
    )
    messageLines.push(...r.msgs.map(summarize))
  }
  hookLines.push(...git.hookLines)
  messageLines.push(...git.messageLines)

  const observations: string[] = [
    `cliVersion=${cliVersion}`,
    `attempts=${runs.length}`,
    `agentCalled=${primary !== undefined}`,
    `agentToolName=${AGENT}`,
    `subagentTools=${primary === undefined ? '' : [...new Set(primary.pre.filter(p => p.agentId !== null).map(p => p.tool))].join(',')}`,
    ...(['a', 'b', 'c', 'd', 'e'] as const).map(l => `${l}=${letters[l].status}`),
  ]

  const subs: ItemResult[] = [
    sub('a', 'stub tool called from the custom subagent with agent_id', letters.a),
    sub('b', 'subagent side effects blocked by its definition', letters.b),
    sub('c', 'hook agent_type equals the custom definition', letters.c),
    sub('d', 'host instruction reached the subagent through the prompt rewrite', letters.d),
    sub('e', 'Agent PostToolUse response carries the subagent final text', letters.e),
    sub('f', 'cost and token accounting of the custom subagent (information only)', f),
    sub('g', 'worktree .git writes under the worker guard (information only)', {
      status: git.status,
      summary: `g.write=${git.observations.find(o => o.startsWith('g.write='))?.slice(8) ?? '?'}; g.bash=${git.observations.find(o => o.startsWith('g.bash='))?.slice(7) ?? '?'}`,
      observations: git.observations,
    }),
  ]

  const anyFail = failed.length > 0
  const status: Status = primary === undefined ? 'NOT-RUN' : anyFail ? 'FAIL' : 'PASS'

  return {
    ...META,
    status,
    ...(primary === undefined ? { reason: 'model did not call Agent' } : {}),
    deviation: false,
    summary,
    observations,
    evidence: [...hookLines, ...messageLines],
    attempts: runs.length + 1,
    costs: [...runs.map(r => [costOf(r)]), git.costs],
    sub: subs,
  }
}

export const item: SpikeItem = { ...META, adrs: 'reviewer-subagent', live: true, estimateUsd: 1.2, run }

if (isMain(import.meta.url)) {
  process.exitCode = await execute({
    items: [item],
    out: fileURLToPath(new URL('../../../.docs/spikes/reviewer-subagent.md', import.meta.url)),
    env: process.env,
    stdout: s => process.stdout.write(s),
    stderr: s => process.stderr.write(s),
  })
}
