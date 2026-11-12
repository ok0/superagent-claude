// Measures subagent hook inputs, foreground forcing, built-in subagent types and cost accounting on the installed SDK.
// Runs in a local temp repository only, with no remote.
import { randomUUID, type UUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query, type HookCallback, type PreToolUseHookInput, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { execute } from '../lib/harness.ts'
import { baseOptions } from '../lib/session.ts'
import { isMain, type ItemResult, type SpikeContext, type SpikeItem, type Status } from '../lib/types.ts'

const META = {
  id: 'subagent',
  req: 'subagent',
  title: 'subagent hook agent_id, foreground forcing, built-in types, cost',
  repro: 'SUPERAGENT_CLAUDE_LIVE=1 node spikes/sdk/items/r46-subagent.ts',
}
const AGENT = 'Agent'
const ALLOWLIST_CANDIDATES = ['general-purpose', 'Explore', 'Plan']
const PUSH = /\bgit\b[^\n;&|]*\bpush\b/
const FIRST_TEXT =
  'Call the Agent tool exactly once with subagent_type "general-purpose", run_in_background true, description "read readme", and this prompt: "Run the Bash command git push origin HEAD:main once. Then read README.md with the Read tool. Then write a 400-word plain description of what a README file is for, and return it." Do not run any tool yourself except Agent. After it returns, reply DONE.'
const RUN_TIMEOUT_MS = 240000
const PER_RUN_MIN_USD = 0.4

type Msg = Record<string, unknown>
type Variant = 'v1' | 'v2'
type Verdict = 'PASS' | 'FAIL' | 'uninformative'

interface HookCall {
  tool: string
  agentId: string | null
  agentType: string | null
  keys: string[]
}

interface Run {
  variant: Variant
  label: string
  msgs: Msg[]
  hookCalls: HookCall[]
  pushDenied: (string | null)[]
  agents: string[]
  error?: string
  timedOut: boolean
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
      tool_use_id: m.tool_use_id,
      task_id: m.task_id,
      is_backgrounded: m.is_backgrounded,
      content,
    }) ?? '',
  )
}

function agentNames(run: Run): Set<string> {
  const names = new Set<string>([AGENT])
  for (const h of run.hookCalls) {
    if (h.agentId === null && h.keys.includes('prompt') && h.keys.includes('description')) names.add(h.tool)
  }
  return names
}

function mainAgentCall(run: Run): { id: string; input: Msg } | undefined {
  const names = agentNames(run)
  for (const m of run.msgs) {
    if (m.type !== 'assistant' || m.parent_tool_use_id !== null) continue
    for (const b of blocks(m)) {
      const name = str(b.name)
      const id = str(b.id)
      if (b.type === 'tool_use' && name !== undefined && id !== undefined && names.has(name)) {
        return { id, input: rec(b.input) ?? {} }
      }
    }
  }
  return undefined
}

function foregroundVerdict(run: Run): { verdict: Verdict; note: string } {
  const call = mainAgentCall(run)
  if (call === undefined) return { verdict: 'uninformative', note: 'no Agent call' }
  if (call.input.run_in_background === false) {
    return { verdict: 'uninformative', note: 'model already sent run_in_background false' }
  }
  const started = run.msgs.find(m => m.type === 'system' && m.subtype === 'task_started' && m.tool_use_id === call.id)
  if (started === undefined) return { verdict: 'FAIL', note: 'no task_started for the Agent call' }
  const taskId = str(started.task_id)
  const listed =
    taskId !== undefined &&
    run.msgs.some(
      m =>
        m.type === 'system' &&
        m.subtype === 'background_tasks_changed' &&
        Array.isArray(m.tasks) &&
        m.tasks.some(t => rec(t)?.task_id === taskId),
    )
  const resultIdx = run.msgs.findIndex(
    m => m.type === 'user' && blocks(m).some(b => b.type === 'tool_result' && b.tool_use_id === call.id),
  )
  const subIdxs = run.msgs.flatMap((m, i) => (m.parent_tool_use_id === call.id ? [i] : []))
  const lastSub = subIdxs.length > 0 ? (subIdxs[subIdxs.length - 1] ?? -1) : -1
  const ok = started.is_backgrounded !== true && !listed && resultIdx !== -1 && resultIdx > lastSub
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    note: `is_backgrounded=${String(started.is_backgrounded)}; listedInBackground=${listed}; resultIdx=${resultIdx}; lastSubagentIdx=${lastSub}`,
  }
}

function costOf(run: Run): number {
  const results = run.msgs.filter(isMainResult)
  const last = results[results.length - 1]
  return last === undefined ? 0 : num(last.total_cost_usd)
}

async function runOnce(ctx: SpikeContext, variant: Variant, attempt: number): Promise<Run> {
  const label = `${variant}#${attempt}`
  const repo = ctx.newRepo(`subagent-${variant}-${attempt}`)
  writeFileSync(join(repo, 'README.md'), 'subagent spike\nline two\n')

  const hookCalls: HookCall[] = []
  const pushDenied: (string | null)[] = []
  const recorder: HookCallback = async input => {
    const h = input as PreToolUseHookInput
    const toolInput = rec(h.tool_input) ?? {}
    const agentId = str(h.agent_id) ?? null
    hookCalls.push({ tool: h.tool_name, agentId, agentType: str(h.agent_type) ?? null, keys: Object.keys(toolInput) })
    const command = str(toolInput.command)
    if (h.tool_name === 'Bash' && command !== undefined && PUSH.test(command)) {
      pushDenied.push(agentId)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'spike deny push',
        },
      }
    }
    if (h.tool_name === AGENT) {
      const updatedInput = { ...toolInput, run_in_background: false }
      if (variant === 'v1') return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput, permissionDecision: 'allow' } }
    }
    return {}
  }

  const options = baseOptions(ctx, repo, {
    permissionMode: 'dontAsk',
    allowDangerouslySkipPermissions: false,
    allowedTools: ['Agent', 'Read', 'Glob', 'Grep', 'Bash'],
    disallowedTools: ['AskUserQuestion', 'WebFetch', 'WebSearch'],
    canUseTool: async (name: string) => ({ behavior: 'deny', message: `${name} is not allowed` }),
    hooks: { PreToolUse: [{ hooks: [recorder], onFailure: 'block' }] },
    maxTurns: 10,
  })

  const msgs: Msg[] = []
  let resolveMain: () => void = () => undefined
  const mainDone = new Promise<void>(resolve => {
    resolveMain = resolve
  })
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: FIRST_TEXT },
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

  const consume = (async () => {
    for await (const m of q) {
      const msg = m as unknown as Msg
      msgs.push(msg)
      if (isMainResult(msg)) resolveMain()
    }
  })()

  let agents: string[] = []
  let error: string | undefined
  try {
    agents = (await q.supportedAgents()).map(a => a.name)
  } catch (e) {
    error = `supportedAgents: ${e instanceof Error ? e.message : String(e)}`
  }
  try {
    await consume
  } catch (e) {
    error = `${error ?? ''} stream: ${e instanceof Error ? e.message : String(e)}`.trim()
  } finally {
    clearTimeout(timer)
  }

  return { variant, label, msgs, hookCalls, pushDenied, agents, error, timedOut }
}

function sub(id: string, title: string, status: Status, summary: string, observations: string[]): ItemResult {
  return {
    id: `subagent-${id}`,
    req: META.req,
    title,
    status,
    deviation: false,
    summary,
    observations,
    evidence: [],
    attempts: 0,
    costs: [],
  }
}

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const runs: Run[] = []
  const spentHere = (): number => sum(runs.map(costOf))

  const attemptsFor = async (variant: Variant): Promise<Verdict> => {
    let verdict: Verdict = 'uninformative'
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (ctx.remainingUsd() - spentHere() < PER_RUN_MIN_USD) break
      const r = await runOnce(ctx, variant, attempt)
      runs.push(r)
      verdict = foregroundVerdict(r).verdict
      if (verdict !== 'uninformative') break
    }
    return verdict
  }

  const v1 = await attemptsFor('v1')
  let v2: Verdict | undefined
  if (v1 === 'FAIL') v2 = await attemptsFor('v2')
  const foreground = v1 === 'PASS' ? 'v1' : v2 === 'PASS' ? 'v2' : 'none'

  const primary = runs.find(r => mainAgentCall(r) !== undefined)
  const init = primary?.msgs.find(m => m.type === 'system' && m.subtype === 'init')
  const cliVersion = str(init?.claude_code_version) ?? 'unknown'
  const initAgents = Array.isArray(init?.agents) ? init.agents.map(String) : []
  const fgNotes = runs.map(r => `${r.label}: ${foregroundVerdict(r).verdict} (${foregroundVerdict(r).note})`)

  const observations: string[] = [
    `cliVersion=${cliVersion}`,
    `initAgents=${initAgents.join(',')}`,
    `foreground=${foreground}`,
    `foregroundV1=${v1}`,
    ...(v2 !== undefined ? [`foregroundV2=${v2}`] : []),
    ...fgNotes.map(n => `foregroundRun ${n}`),
  ]
  const evidence: string[] = []
  for (const r of runs) {
    evidence.push(`run ${r.label} timedOut=${r.timedOut}${r.error !== undefined ? ` error=${r.error}` : ''}`)
    evidence.push(
      ...r.hookCalls.map(h =>
        clip(`hook tool=${h.tool} agentId=${h.agentId} agentType=${h.agentType} keys=${h.keys.join(',')}`),
      ),
    )
    evidence.push(...r.msgs.map(summarize))
  }

  if (primary === undefined) {
    const status: Status = 'NOT-RUN'
    observations.push('a=NOT-RUN', 'b=' + (v1 === 'uninformative' ? 'uninformative' : v1), 'c=NOT-RUN', 'd=NOT-RUN')
    return {
      ...META,
      status,
      reason: 'model did not call Agent',
      deviation: false,
      summary: 'Agent 호출 없음 — 판정 보류',
      observations,
      evidence,
      attempts: runs.length,
      costs: runs.map(r => [costOf(r)]),
      sub: [
        sub('a', 'hook agent_id on subagent tools', 'NOT-RUN', 'no Agent call', []),
        sub('b', 'foreground forcing', v1 === 'PASS' ? 'PASS' : 'NOT-RUN', `foreground=${foreground}`, []),
        sub('c', 'built-in subagent types', 'NOT-RUN', 'no Agent call', []),
        sub('d', 'cost accounting', 'NOT-RUN', 'no Agent call', []),
      ],
    }
  }

  const call = mainAgentCall(primary)
  const agentName = [...agentNames(primary)].find(n => n !== AGENT) ?? AGENT
  const subs = primary.hookCalls.filter(h => h.agentId !== null)
  const mainAgentHook = primary.hookCalls.find(
    h => h.tool === agentName && h.agentId === null && h.keys.includes('prompt') && h.keys.includes('description'),
  )
  const subTools = [...new Set(subs.map(h => h.tool))]
  const agentIdSeen = subs.length > 0
  const aPass = agentIdSeen && mainAgentHook !== undefined
  const pushDeniedInSubagent = primary.pushDenied.filter(id => id !== null).length
  observations.push(
    `agentToolName=${agentName}`,
    `agentIdSeen=${agentIdSeen}`,
    `subagentTools=${subTools.join(',')}`,
    `mainAgentHookAgentId=${mainAgentHook === undefined ? 'missing' : 'null'}`,
    `a=${aPass ? 'PASS' : 'FAIL'}`,
  )

  const agents = primary.agents
  const allowlist = ALLOWLIST_CANDIDATES.filter(n => agents.includes(n))
  const cPass = agents.length > 0
  observations.push(
    `subagentTypes=${agents.join(',')}`,
    `allowlist=${allowlist.join(',')}`,
    `c=${cPass ? 'PASS' : 'FAIL'}`,
  )

  const mainResults = primary.msgs.filter(isMainResult)
  const resultMsg = mainResults[mainResults.length - 1]
  let dPass = false
  let dNote = 'no main-thread result'
  if (resultMsg !== undefined && call !== undefined) {
    const T = num(resultMsg.total_cost_usd)
    const modelUsage = Object.values(rec(resultMsg.modelUsage) ?? {}).map(v => rec(v) ?? {})
    const S = sum(modelUsage.map(u => num(u.costUSD)))
    const O = sum(modelUsage.map(u => num(u.outputTokens)))
    const U = num(rec(resultMsg.usage)?.output_tokens)
    const perMessage = new Map<string, number>()
    for (const m of primary.msgs) {
      if (m.type !== 'assistant' || m.parent_tool_use_id !== call.id) continue
      const message = rec(m.message)
      const id = str(message?.id) ?? ''
      const out = num(rec(message?.usage)?.output_tokens)
      perMessage.set(id, Math.max(perMessage.get(id) ?? 0, out))
    }
    const subTokens = sum([...perMessage.values()])
    const costOk = Math.abs(T - S) <= Math.max(1e-6, 0.01 * T)
    const tokensOk = O - U >= Math.max(200, 0.9 * subTokens)
    dPass = costOk && tokensOk
    dNote = `T=${T}; S=${S}; O=${O}; U=${U}; sub=${subTokens}; costOk=${costOk}; tokensOk=${tokensOk}`
    observations.push(
      `T=${T}`,
      `S=${S}`,
      `O=${O}`,
      `U=${U}`,
      `sub=${subTokens}`,
      `cost=${costOk ? 'included' : 'NOT included'}`,
    )
  }
  observations.push(`d=${dPass ? 'PASS' : 'FAIL'}`, `pushDeniedInSubagent=${pushDeniedInSubagent}`)

  const bVerdict = foregroundVerdict(primary).verdict
  const fail = !aPass || !dPass || !cPass
  const status: Status = fail ? 'FAIL' : 'PASS'
  const summary = `a=${aPass ? 'PASS' : 'FAIL'}, b=${bVerdict}(${foreground}), c=${cPass ? 'PASS' : 'FAIL'}, d=${dPass ? 'PASS' : 'FAIL'}`

  return {
    ...META,
    status,
    deviation: false,
    summary,
    observations,
    evidence,
    attempts: runs.length,
    costs: runs.map(r => [costOf(r)]),
    sub: [
      sub(
        'a',
        'hook agent_id on subagent tools',
        aPass ? 'PASS' : 'FAIL',
        `agentIdSeen=${agentIdSeen}; mainAgentHook=${mainAgentHook !== undefined}`,
        [`agentToolName=${agentName}`, `subagentTools=${subTools.join(',')}`],
      ),
      sub(
        'b',
        'foreground forcing',
        bVerdict === 'PASS' ? 'PASS' : bVerdict === 'FAIL' ? 'FAIL' : 'NOT-RUN',
        `foreground=${foreground}`,
        fgNotes,
      ),
      sub('c', 'built-in subagent types', cPass ? 'PASS' : 'FAIL', `allowlist=${allowlist.join(',')}`, [
        `subagentTypes=${agents.join(',')}`,
        `allowlist=${allowlist.join(',')}`,
      ]),
      sub('d', 'cost accounting', dPass ? 'PASS' : 'FAIL', dNote, [dNote]),
    ],
  }
}

export const item: SpikeItem = { ...META, adrs: 'subagent', live: true, estimateUsd: 0.4, run }

if (isMain(import.meta.url)) {
  process.exitCode = await execute({
    items: [item],
    out: fileURLToPath(new URL('../../../.docs/spikes/subagent.md', import.meta.url)),
    env: process.env,
    stdout: s => process.stdout.write(s),
    stderr: s => process.stderr.write(s),
  })
}
