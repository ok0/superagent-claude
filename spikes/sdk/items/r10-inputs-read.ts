import { randomUUID } from 'node:crypto'
import { baseOptions, compact, findEcho, runScenario, type TimelineEntry } from '../lib/session.ts'
import { isMain, type ItemResult, type SpikeContext, type SpikeItem } from '../lib/types.ts'

const ID = 'inputs-read'
const REQ = 'inputs-read'
const TITLE = 'inputsRead 근사: user_message_uuid 에코 위치'

function initLines(init: Record<string, unknown> | undefined): string[] {
  if (init === undefined) return []
  return [
    `apiKeySource=${String(init.apiKeySource ?? 'unknown')}`,
    `cliVersion=${String(init.claude_code_version ?? 'unknown')}`,
  ]
}

function hitsText(timeline: TimelineEntry[], uuid: string): string {
  const hits = findEcho(timeline, uuid)
  return hits.length === 0 ? 'none' : hits.map(h => `${h.type}.${h.field}@${h.index}`).join(',')
}

export const item: SpikeItem = {
  id: ID,
  req: REQ,
  title: TITLE,
  adrs: 'input-delivery',
  live: true,
  estimateUsd: 0.2,
  run,
}

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const A = randomUUID()
  const B = randomUUID()
  const C = randomUUID()
  let pushedC = false
  let pushedB = false
  let bEchoed = false

  const outcome = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo(`${ID}-1`)),
    first: { text: 'Reply with exactly: OK1', uuid: A },
    timeoutMs: 90000,
    onEntry: (e, c) => {
      if (e.type === 'result' && !pushedC && c.results.length === 1) {
        pushedC = true
        c.push({ text: 'Use the Bash tool to run exactly: sleep 5; echo S2 . Then reply DONE2.', uuid: C })
      }
      if (pushedC && !pushedB && e.toolUses?.some(u => u.name === 'Bash') === true) {
        pushedB = true
        c.push({ text: 'Also include the word KIWI in your reply.', uuid: B, priority: 'next' })
      }
      if (!bEchoed && findEcho(c.timeline, B).length > 0) bEchoed = true
      if (c.results.length >= 3 || (e.type === 'result' && bEchoed)) c.end()
    },
  })

  const tl = outcome.timeline
  const aHits = findEcho(tl, A)
  const bHits = findEcho(tl, B)
  const firstAssistant = tl.findIndex(e => e.type === 'assistant')
  const firstResult = tl.findIndex(e => e.type === 'result')
  const toolResult = tl.findIndex(e => (e.toolResults?.length ?? 0) > 0)
  const kiwi = tl.findIndex(e => e.type === 'assistant' && (e.text ?? '').includes('KIWI'))
  const bFirst = bHits[0]?.index ?? -1
  const nextAssistant = bFirst === -1 ? -1 : tl.findIndex((e, i) => i > bFirst && e.type === 'assistant')

  const observations: string[] = [
    ...initLines(outcome.init),
    `A echo: ${hitsText(tl, A)}; first_assistant=${firstAssistant}; first_result=${firstResult}`,
    `B echo: ${hitsText(tl, B)}; in_flight_tool_result=${toolResult}; kiwi_frame=${kiwi}; next_assistant_after_echo=${nextAssistant}`,
  ]
  if (outcome.error !== undefined) observations.push(`error: ${outcome.error}`)

  const bAfterTool = toolResult !== -1 && bFirst > toolResult
  const bBeforeKiwi = kiwi === -1 || (bFirst !== -1 && bFirst <= kiwi)
  const onlyResultA = aHits.length > 0 && aHits.every(h => h.type === 'result')
  const onlyResultB = bHits.length > 0 && bHits.every(h => h.type === 'result')

  let status: ItemResult['status']
  let deviation = false
  let summary: string
  if (aHits.length === 0 || bHits.length === 0) {
    status = 'FAIL'
    summary = `에코 없음 (A=${aHits.length > 0}, B=${bHits.length > 0})`
  } else if (bAfterTool && bBeforeKiwi && !onlyResultA && !onlyResultB) {
    status = 'PASS'
    summary = 'A·B 에코 확인, B는 in-flight tool_result 이후 사용 프레임 이전에 반영'
  } else {
    status = 'PASS'
    deviation = true
    summary = '에코는 존재하나 위치 편차 (result 전용 에코 또는 사용 프레임 이후 에코)'
  }

  return {
    id: ID,
    req: REQ,
    title: TITLE,
    status,
    deviation,
    summary,
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
