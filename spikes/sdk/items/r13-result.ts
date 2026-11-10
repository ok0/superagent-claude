import { baseOptions, compact, runScenario, type ScenarioOutcome, type TimelineEntry } from '../lib/session.ts'
import { isMain, type ItemResult, type SpikeContext, type SpikeItem } from '../lib/types.ts'

const ID = 'result'
const REQ = 'R13'
const TITLE = 'result 메시지 의미 (비용·턴·maxTurns)'

type CostModel = 'cumulative' | 'per-turn' | 'unknown'

function initLines(init: Record<string, unknown> | undefined): string[] {
  if (init === undefined) return []
  return [
    `apiKeySource=${String(init.apiKeySource ?? 'unknown')}`,
    `cliVersion=${String(init.claude_code_version ?? 'unknown')}`,
  ]
}

function costModelOf(results: TimelineEntry[]): CostModel {
  const three = results.slice(0, 3)
  if (three.length < 3) return 'unknown'
  const costRaw = three.map((r) => r.result?.totalCostUsd)
  const turnRaw = three.map((r) => r.result?.numTurns)
  if (costRaw.some((v) => v === undefined) || turnRaw.some((v) => v === undefined)) return 'unknown'
  const costs = costRaw as number[]
  const turns = turnRaw as number[]
  const rising = (xs: number[]): boolean => xs.slice(1).every((x, i) => x >= (xs[i] ?? 0))
  const c1 = costs[0] ?? 0
  const c3 = costs[2] ?? 0
  const t1 = turns[0] ?? 0
  const t3 = turns[2] ?? 0
  if (rising(costs) && rising(turns) && c3 > c1) return 'cumulative'
  if (t3 <= t1 && !rising(costs)) return 'per-turn'
  return 'unknown'
}

function isSuccess(e: TimelineEntry): boolean {
  const res = e.result
  return res !== undefined && res.subtype === 'success' && res.totalCostUsd !== undefined && res.numTurns !== undefined
}

function subtypesOf(outcome: ScenarioOutcome): string {
  return outcome.results.map((r) => r.result?.subtype ?? 'none').join(',') || 'none'
}

export const item: SpikeItem = { id: ID, req: REQ, title: TITLE, adrs: 'ADR-6', live: true, estimateUsd: 0.35, run }

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const repoA = ctx.newRepo(`${ID}-a`)
  const a = await runScenario({
    ctx,
    options: baseOptions(ctx, repoA),
    first: { text: 'Reply with exactly ONE' },
    onEntry: (e, c) => {
      if (e.type !== 'result') return
      if (c.results.length === 1) c.push({ text: 'Reply with exactly TWO' })
      else if (c.results.length === 2) c.push({ text: 'Reply with exactly THREE' })
      else c.end()
    },
  })

  const costModel = costModelOf(a.results)
  const aLast = a.results[a.results.length - 1]?.result
  const sessionA = a.sessionId

  let resumeContinuity: 'continues' | 'resets' | 'unknown' = 'unknown'
  let b: ScenarioOutcome | undefined
  if (sessionA !== undefined) {
    b = await runScenario({
      ctx,
      options: baseOptions(ctx, repoA, { resume: sessionA }),
      first: { text: 'Reply with exactly FOUR' },
      onEntry: (e, c) => {
        if (e.type === 'result') c.end()
      },
    })
    const bRes = b.results[0]?.result
    if (
      aLast !== undefined &&
      bRes !== undefined &&
      aLast.totalCostUsd !== undefined &&
      aLast.numTurns !== undefined &&
      bRes.totalCostUsd !== undefined &&
      bRes.numTurns !== undefined
    ) {
      resumeContinuity = bRes.numTurns > aLast.numTurns && bRes.totalCostUsd >= aLast.totalCostUsd ? 'continues' : 'resets'
    }
  }

  const cRun = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo(`${ID}-c`), { maxTurns: 1 }),
    first: { text: 'Use the Bash tool to run: echo a . Then use the Bash tool again to run: echo b . Then reply DONE.' },
    onEntry: (e, c) => {
      if (e.type === 'result') c.end()
    },
  })
  const cSubtype = cRun.results[0]?.result?.subtype ?? 'none'

  const d = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo(`${ID}-d`), { maxTurns: 2 }),
    first: { text: 'Reply with exactly OK' },
    onEntry: (e, c) => {
      if (e.type !== 'result') return
      if (c.results.length < 3) c.push({ text: 'Reply with exactly OK' })
      else c.end()
    },
  })
  const dSubtypes = d.results.map((r) => r.result?.subtype ?? 'none')
  const maxTurnsUnit = dSubtypes[1] === 'error_max_turns' || dSubtypes[2] === 'error_max_turns' ? 'session' : 'per-message'

  const aOk = a.results.length === 3 && a.results.every(isSuccess)
  const cOk = cSubtype === 'error_max_turns'
  const pass = aOk && cOk

  const observations: string[] = [
    ...initLines(a.init),
    `costModel=${costModel}`,
    `resumeContinuity=${resumeContinuity}`,
    `maxTurnsUnit=${maxTurnsUnit}`,
    `session a (streaming): subtypes=${subtypesOf(a)}; costs=${a.results.map((r) => r.result?.totalCostUsd ?? 'n/a').join(',')}; num_turns=${a.results.map((r) => r.result?.numTurns ?? 'n/a').join(',')}`,
    `session b (resume): ${b === undefined ? 'not run (no session id)' : `subtypes=${subtypesOf(b)}; cost=${b.results[0]?.result?.totalCostUsd ?? 'n/a'}; num_turns=${b.results[0]?.result?.numTurns ?? 'n/a'}`}`,
    `session c (maxTurns=1): subtype=${cSubtype}`,
    `session d (maxTurns=2, three messages): subtypes=${subtypesOf(d)}`,
    `aOk=${aOk}; cOk=${cOk}`,
  ]
  for (const [label, outcome] of [['a', a], ['b', b], ['c', cRun], ['d', d]] as const) {
    if (outcome?.error !== undefined) observations.push(`session ${label} error: ${outcome.error}`)
  }

  const evidence: string[] = []
  const sessions: [string, ScenarioOutcome | undefined][] = [['a', a], ['b', b], ['c', cRun], ['d', d]]
  for (const [label, outcome] of sessions) {
    if (outcome === undefined) continue
    evidence.push(`session ${label}`, ...outcome.timeline.map(compact))
  }

  const costs = [a.costs, ...(b !== undefined ? [b.costs] : []), cRun.costs, d.costs]
  const summary = `costModel=${costModel}; maxTurnsUnit=${maxTurnsUnit}; resumeContinuity=${resumeContinuity}`

  return {
    id: ID,
    req: REQ,
    title: TITLE,
    status: pass ? 'PASS' : 'FAIL',
    deviation: pass && maxTurnsUnit === 'session',
    summary,
    observations,
    evidence,
    attempts: 1,
    costs,
  }
}

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
