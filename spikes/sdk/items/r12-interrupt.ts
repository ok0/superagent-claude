import { randomUUID } from 'node:crypto'
import { baseOptions, compact, findEcho, runScenario } from '../lib/session.ts'
import { isMain, type ItemResult, type SpikeContext, type SpikeItem } from '../lib/types.ts'

const ID = 'interrupt'
const REQ = 'R12'
const TITLE = 'interrupt 영수증(still_queued) 및 이후 처리 확인'

function initLines(init: Record<string, unknown> | undefined): string[] {
  if (init === undefined) return []
  return [
    `apiKeySource=${String(init.apiKeySource ?? 'unknown')}`,
    `cliVersion=${String(init.claude_code_version ?? 'unknown')}`,
  ]
}

export const item: SpikeItem = { id: ID, req: REQ, title: TITLE, adrs: 'ADR-5', live: true, estimateUsd: 0.15, run }

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const A = randomUUID()
  const B = randomUUID()
  let pushedB = false
  let interrupted = false
  let receiptJson = ''
  let stillQueuedHasB = false
  let interruptError: string | undefined
  let processedAfter = false

  const outcome = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo(`${ID}-1`)),
    first: { text: 'Use the Bash tool to run exactly: sleep 20; echo LONG . Then reply LONGDONE.', uuid: A },
    onEntry: (e, c) => {
      if (!pushedB && e.toolUses?.some(u => u.name === 'Bash') === true) {
        pushedB = true
        c.push({ text: 'Reply with exactly QUEUEDWORD.', uuid: B, priority: 'later' })
        c.after(2000, async cc => {
          try {
            const receipt = await cc.interrupt()
            receiptJson = JSON.stringify(receipt)
            stillQueuedHasB = receiptJson.includes(B)
            interrupted = true
            cc.after(60000, c3 => c3.end())
          } catch (err) {
            interruptError = err instanceof Error ? err.message : String(err)
          }
        })
      }
      if (interrupted && (e.text?.includes('QUEUEDWORD') === true || findEcho(c.timeline, B).length > 0)) {
        processedAfter = true
        c.end()
      }
    },
  })

  const observations: string[] = [
    ...initLines(outcome.init),
    `receipt=${receiptJson}`,
    `stillQueuedHasB=${stillQueuedHasB}`,
    `processedAfter=${processedAfter}`,
  ]
  if (interruptError !== undefined) observations.push(`interrupt error: ${interruptError}`)
  if (outcome.error !== undefined) observations.push(`error: ${outcome.error}`)

  let status: ItemResult['status']
  let deviation = false
  let summary: string
  if (!stillQueuedHasB) {
    status = 'FAIL'
    summary = 'interrupt 영수증에 still_queued(B) 없음'
  } else if (processedAfter) {
    status = 'PASS'
    summary = 'still_queued 영수증 확인, interrupt 후 B 처리 확인'
  } else {
    status = 'PASS'
    deviation = true
    summary = 'still_queued 메시지가 interrupt 후 처리되지 않음'
  }

  return {
    id: ID,
    req: REQ,
    title: TITLE,
    status,
    deviation,
    summary,
    observations,
    evidence: outcome.timeline.map(compact),
    attempts: 1,
    costs: [outcome.costs],
  }
}

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
