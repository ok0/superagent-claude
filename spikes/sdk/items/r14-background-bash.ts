import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { baseOptions, compact, runScenario, type ScenarioOutcome, type TimelineEntry } from '../lib/session.ts'
import { isMain, type ItemResult, type SpikeContext, type SpikeItem } from '../lib/types.ts'

const ID = 'background-bash'
const REQ = 'background-bash'
const TITLE = 'run_in_background 즉시 반환 및 후속 턴 확인'
const ATTEMPTS = 3
const PROMPT =
  'Use the Bash tool with run_in_background set to true to run exactly: sleep 10; echo BGDONE > bg.txt . Do not wait for it and do not check on it. Reply with exactly STARTED.'

interface Attempt {
  outcome: ScenarioOutcome
  bgFlag: boolean
  toolReturnMs: number | undefined
  firstResultT: number
  earlyNotification: boolean
  success: boolean
  notificationKeys: string[]
  bgFile: boolean
}

function initLines(init: Record<string, unknown> | undefined): string[] {
  if (init === undefined) return []
  return [
    `apiKeySource=${String(init.apiKeySource ?? 'unknown')}`,
    `cliVersion=${String(init.claude_code_version ?? 'unknown')}`,
  ]
}

function isTaskEntry(e: TimelineEntry): boolean {
  return e.type === 'system' && (e.subtype ?? '').includes('task')
}

async function attempt(ctx: SpikeContext, n: number): Promise<Attempt> {
  const repo = ctx.newRepo(`${ID}-${n}`)
  const outcome = await runScenario({
    ctx,
    options: baseOptions(ctx, repo),
    first: { text: PROMPT },
    onEntry: (e, c) => {
      if (e.type !== 'result') return
      if (c.results.length === 1) c.after(60000, cc => cc.end())
      else if (c.results.length >= 2) c.end()
    },
  })

  const tl = outcome.timeline
  const bashIdx = tl.findIndex(e => e.toolUses?.some(u => u.name === 'Bash') === true)
  const bashEntry = tl[bashIdx]
  const bgFlag = tl.some(e =>
    (e.toolUses ?? []).some(u => u.name === 'Bash' && u.input.includes('"run_in_background":true')),
  )
  const toolResultEntry = bashIdx === -1 ? undefined : tl.slice(bashIdx + 1).find(e => (e.toolResults?.length ?? 0) > 0)
  const toolReturnMs =
    bashEntry !== undefined && toolResultEntry !== undefined ? toolResultEntry.t - bashEntry.t : undefined

  const firstIdx = tl.findIndex(e => e.type === 'result')
  const firstResultT = tl[firstIdx]?.t ?? -1
  const after = firstIdx === -1 ? [] : tl.slice(firstIdx + 1)
  const followUp = after.find(e => isTaskEntry(e) || e.type === 'result')
  const earlyNotification = firstIdx === -1 ? false : tl.slice(0, firstIdx).some(isTaskEntry)
  const note = after.find(isTaskEntry)
  const success = bgFlag && toolReturnMs !== undefined && toolReturnMs < 5000 && followUp !== undefined

  return {
    outcome,
    bgFlag,
    toolReturnMs,
    firstResultT,
    earlyNotification,
    success,
    notificationKeys: note?.keys ?? [],
    bgFile: existsSync(join(repo, 'bg.txt')),
  }
}

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const observations: string[] = []
  const evidence: string[] = []
  const costs: number[][] = []
  const attempts: Attempt[] = []
  let init: Record<string, unknown> | undefined

  for (let n = 1; n <= ATTEMPTS; n++) {
    if (ctx.remainingUsd() <= 0) {
      observations.push(`budget exhausted before attempt ${n}`)
      break
    }
    const r = await attempt(ctx, n)
    attempts.push(r)
    init ??= r.outcome.init
    costs.push(r.outcome.costs)
    const origins = r.outcome.results.slice(1).map(e => JSON.stringify(e.result?.origin ?? null))
    observations.push(
      `attempt ${n}: bgFlag=${r.bgFlag}; toolReturnMs=${r.toolReturnMs ?? 'n/a'}; firstResultT=${r.firstResultT}; success=${r.success}; earlyNotification=${r.earlyNotification}; bgFile=${r.bgFile}; notificationKeys=${r.notificationKeys.join('|') || 'none'}`,
    )
    if (origins.length > 0) observations.push(`attempt ${n} later result origins: ${origins.join(' ; ')}`)
    if (r.outcome.error !== undefined) observations.push(`attempt ${n} error: ${r.outcome.error}`)
    evidence.push(`attempt ${n}`, ...r.outcome.timeline.map(compact))
    ctx.log(`${ID} attempt ${n}: success=${r.success}`)
  }

  const used = attempts.filter(a => a.bgFlag).length
  const successes = attempts.filter(a => a.success).length
  const deviation = attempts.some(a => a.earlyNotification)
  observations.unshift(...initLines(init), `successes=${successes}/${attempts.length}; flag_used=${used}`)

  let status: ItemResult['status']
  let reason: string | undefined
  let summary: string
  if (attempts.length === 0) {
    status = 'NOT-RUN'
    reason = 'budget'
    summary = '예산 부족으로 시도하지 않음'
  } else if (used === 0) {
    status = 'NOT-RUN'
    reason = 'model did not use run_in_background'
    summary = `${ATTEMPTS}회 시도에서 run_in_background 미사용`
  } else if (successes >= 2) {
    status = 'PASS'
    summary = deviation
      ? `run_in_background 즉시 반환 + 후속 턴 ${successes}/${attempts.length} 성공; 알림이 1차 결과 이전 도착(편차)`
      : `run_in_background 즉시 반환 + 후속 턴 ${successes}/${attempts.length} 성공`
  } else {
    status = 'FAIL'
    summary = `후속 턴 ${successes}/${attempts.length} 성공 (run_in_background 사용 ${used}회)`
  }

  return {
    id: ID,
    req: REQ,
    title: TITLE,
    status,
    reason,
    deviation: status === 'PASS' && deviation,
    summary,
    observations,
    evidence,
    attempts: attempts.length,
    costs,
  }
}

export const item: SpikeItem = {
  id: ID,
  req: REQ,
  title: TITLE,
  adrs: 'input-delivery',
  live: true,
  estimateUsd: 0.4,
  run,
}

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
