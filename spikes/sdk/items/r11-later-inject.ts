import { randomUUID } from 'node:crypto'
import { baseOptions, compact, runScenario, textOf, type ScenarioControl, type TimelineEntry } from '../lib/session.ts'
import { isMain, type ItemResult, type SpikeContext, type SpikeItem } from '../lib/types.ts'

const ID = 'later-inject'
const REQ = 'R11'
const TITLE = 'later 큐 전달 및 inject(shouldQuery:false) 확인'

function initLines(init: Record<string, unknown> | undefined): string[] {
  if (init === undefined) return []
  return [
    `apiKeySource=${String(init.apiKeySource ?? 'unknown')}`,
    `cliVersion=${String(init.claude_code_version ?? 'unknown')}`,
  ]
}

export const item: SpikeItem = { id: ID, req: REQ, title: TITLE, adrs: 'ADR-5', live: true, estimateUsd: 0.2, run }

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const A = randomUUID()
  const B = randomUUID()
  const C = randomUUID()
  const D = randomUUID()
  let pushedB = false
  let injected = false
  let injectAt = -1
  let turnStartedByInject = false
  let dIndex = -1
  let dPushed = false

  const inject = (c: ScenarioControl): void => {
    if (injected) return
    injected = true
    injectAt = c.elapsed()
    c.push({ text: 'Remember the code word INJECTWORD. Do not reply.', uuid: C, shouldQuery: false })
    c.after(10000, cc => {
      turnStartedByInject = cc.timeline.some(
        e => e.t >= injectAt && e.t < injectAt + 10000 && (e.type === 'assistant' || e.type === 'result'),
      )
      dIndex = cc.timeline.length
      cc.push({ text: 'What code word were you told to remember? Reply with only the word.', uuid: D })
      dPushed = true
      cc.after(60000, c3 => c3.end())
    })
  }

  const outcome = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo(`${ID}-1`)),
    first: { text: 'Use the Bash tool to run exactly: sleep 6; echo X . Then reply exactly: FIRST DONE', uuid: A },
    onEntry: (e, c) => {
      if (!pushedB && e.toolUses?.some(u => u.name === 'Bash') === true) {
        pushedB = true
        c.push({ text: 'Reply with exactly the single word LATERWORD.', uuid: B, priority: 'later' })
      }
      if (e.type === 'result' && c.results.length === 1) c.after(60000, cc => inject(cc))
      if (e.type === 'result' && c.results.length === 2) inject(c)
      if (dPushed && e.type === 'result') c.end()
    },
  })

  const tl = outcome.timeline
  const firstResult = tl.findIndex((e: TimelineEntry) => e.type === 'result')
  const beforeFirst = textOf(tl.slice(0, firstResult === -1 ? tl.length : firstResult + 1))
  const afterFirst = firstResult === -1 ? '' : textOf(tl.slice(firstResult + 1))
  const laterPass = !beforeFirst.includes('LATERWORD') && afterFirst.includes('LATERWORD')
  const replyToD = dIndex === -1 ? '' : textOf(tl.slice(dIndex))
  const injectPass = !turnStartedByInject && replyToD.includes('INJECTWORD')

  const observations: string[] = [
    ...initLines(outcome.init),
    `later: LATERWORD_before_first_result=${beforeFirst.includes('LATERWORD')}; LATERWORD_after_first_result=${afterFirst.includes('LATERWORD')}; pass=${laterPass}`,
    `inject: turnStartedByInject=${turnStartedByInject}; INJECTWORD_in_reply_to_D=${replyToD.includes('INJECTWORD')}; pass=${injectPass}`,
  ]
  if (outcome.error !== undefined) observations.push(`error: ${outcome.error}`)

  const pass = laterPass && injectPass
  return {
    id: ID,
    req: REQ,
    title: TITLE,
    status: pass ? 'PASS' : 'FAIL',
    deviation: false,
    summary: pass ? 'later 전달 및 inject(shouldQuery:false) 모두 확인' : `later=${laterPass}, inject=${injectPass}`,
    observations,
    evidence: tl.map(compact),
    attempts: 1,
    costs: [outcome.costs],
  }
}

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
