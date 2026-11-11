import { randomUUID } from 'node:crypto'
import {
  baseOptions,
  compact,
  findEcho,
  runScenario,
  textOf,
  type ScenarioOutcome,
  type TimelineEntry,
} from '../lib/session.ts'
import { isMain, type ItemResult, type SpikeContext, type SpikeItem } from '../lib/types.ts'

const ID = 'steer'
const REQ = 'R9'
const TITLE = 'steer 입력 반영 시점 (priority: next)'
const MARKER = 'PINEAPPLE'
const ATTEMPTS = 3

type Klass = 'same-turn' | 'next-turn' | 'lost'

function initLines(init: Record<string, unknown> | undefined): string[] {
  if (init === undefined) return []
  return [
    `apiKeySource=${String(init.apiKeySource ?? 'unknown')}`,
    `cliVersion=${String(init.claude_code_version ?? 'unknown')}`,
  ]
}

function classify(timeline: TimelineEntry[]): Klass {
  const first = timeline.findIndex(e => e.type === 'result')
  const cut = first === -1 ? timeline.length : first + 1
  if (textOf(timeline.slice(0, cut)).includes(MARKER)) return 'same-turn'
  if (textOf(timeline.slice(cut)).includes(MARKER)) return 'next-turn'
  return 'lost'
}

async function attempt(ctx: SpikeContext, n: number): Promise<{ outcome: ScenarioOutcome; bUuid: string }> {
  const bUuid = randomUUID()
  let injected = false
  let firstResultSeen = false
  const outcome = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo(`${ID}-${n}`)),
    first: {
      text: 'Use the Bash tool to run exactly: sleep 8; echo STEP1_DONE . After it finishes, give your final answer. Follow any additional instructions you receive.',
      uuid: randomUUID(),
    },
    onEntry: (e, c) => {
      if (!injected && e.toolUses?.some(u => u.name === 'Bash') === true) {
        injected = true
        c.push({
          text: `Additional instruction: your final answer must contain the word ${MARKER}.`,
          uuid: bUuid,
          priority: 'next',
        })
      }
      if (e.type !== 'result') return
      if (c.results.length >= 2) {
        c.end()
      } else if (!firstResultSeen) {
        firstResultSeen = true
        c.after(60000, cc => cc.end())
      }
    },
  })
  return { outcome, bUuid }
}

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const observations: string[] = []
  const evidence: string[] = []
  const costs: number[][] = []
  const counts: Record<Klass, number> = { 'same-turn': 0, 'next-turn': 0, lost: 0 }
  let init: Record<string, unknown> | undefined

  for (let n = 1; n <= ATTEMPTS; n++) {
    if (ctx.remainingUsd() <= 0) {
      observations.push(`budget exhausted before attempt ${n}`)
      break
    }
    const { outcome, bUuid } = await attempt(ctx, n)
    const klass = classify(outcome.timeline)
    counts[klass] += 1
    init ??= outcome.init
    costs.push(outcome.costs)
    const echo = findEcho(outcome.timeline, bUuid)[0]?.index ?? -1
    const toolResult = outcome.timeline.findIndex(e => (e.toolResults?.length ?? 0) > 0)
    const firstResult = outcome.timeline.findIndex(e => e.type === 'result')
    const numTurns = firstResult === -1 ? undefined : outcome.timeline[firstResult]?.result?.numTurns
    observations.push(
      `attempt ${n}: ${klass}; echo(B)=${echo}; bash_tool_result=${toolResult}; first_result=${firstResult}; num_turns=${numTurns ?? 'n/a'}`,
    )
    if (outcome.error !== undefined) observations.push(`attempt ${n} error: ${outcome.error}`)
    evidence.push(`attempt ${n}`, ...outcome.timeline.map(compact))
    ctx.log(`${ID} attempt ${n}: ${klass}`)
  }

  const same = counts['same-turn']
  const next = counts['next-turn']
  const lost = counts.lost
  const attempts = costs.length
  observations.unshift(...initLines(init), `counts: same-turn=${same}, next-turn=${next}, lost=${lost}`)

  let status: ItemResult['status']
  let deviation = false
  let summary: string
  let reason: string | undefined
  if (same >= 2) {
    status = 'PASS'
    summary = `같은 턴 반영 ${same}/${attempts}`
  } else if (lost >= 2) {
    status = 'FAIL'
    summary = `${MARKER} 미반영 ${lost}/${attempts}`
  } else if (next >= 2 || (same + next >= 2 && lost < 2)) {
    status = 'PASS'
    deviation = true
    summary = '같은 턴 미반영(다음 턴) — followup 강등 대체안 해당'
  } else {
    status = 'NOT-RUN'
    reason = `inconclusive after ${attempts} attempt(s)`
    summary = `판정 보류 (same-turn=${same}, next-turn=${next}, lost=${lost})`
  }

  return { id: ID, req: REQ, title: TITLE, status, reason, deviation, summary, observations, evidence, attempts, costs }
}

export const item: SpikeItem = { id: ID, req: REQ, title: TITLE, adrs: 'ADR-5', live: true, estimateUsd: 0.4, run }

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
