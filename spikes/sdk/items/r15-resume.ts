import type { ItemResult, SpikeContext, SpikeItem } from '../lib/types.ts'
import { isMain } from '../lib/types.ts'
import { baseOptions, compact, field, runScenario, textOf } from '../lib/session.ts'

const META = { id: 'resume', req: 'R15', title: 'resume 시 기억·systemPrompt 재적용' }
const ALPHA = 'You are a test agent. End every reply with the tag [SP-ALPHA].'
const BETA = 'You are a test agent. End every reply with the tag [SP-BETA].'
const QUESTION = 'What was the secret word? Reply with only the word.'

function tagOf(text: string): 'BETA' | 'ALPHA' | 'none' {
  if (text.includes('[SP-BETA]')) return 'BETA'
  if (text.includes('[SP-ALPHA]')) return 'ALPHA'
  return 'none'
}

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const observations: string[] = []
  const evidence: string[] = []
  const costs: number[][] = []

  const repo1 = ctx.newRepo('resume-1')
  const first = await runScenario({
    ctx,
    options: baseOptions(ctx, repo1, { systemPrompt: ALPHA }),
    first: { text: 'Remember the secret word MANGO. Reply with OK.' },
    onEntry: (e, c) => {
      if (e.type === 'result') c.end()
    },
  })
  costs.push(first.costs)
  if (first.init !== undefined) {
    observations.push(
      `apiKeySource=${String(field(first.init, 'apiKeySource'))}`,
      `cliVersion=${String(field(first.init, 'claude_code_version'))}`,
    )
  }
  evidence.push(...first.timeline.map(compact))
  const sid = first.sessionId
  if (sid === undefined) {
    return {
      ...META,
      status: 'FAIL',
      deviation: false,
      summary: '세션 1 sessionId 없음 — resume 검증 불가',
      observations,
      evidence,
      attempts: 0,
      costs,
    }
  }

  let memoryA = false
  let tagA: 'BETA' | 'ALPHA' | 'none' = 'none'
  let attempts = 0
  while (attempts < 3) {
    attempts += 1
    const outcome = await runScenario({
      ctx,
      options: baseOptions(ctx, repo1, { resume: sid, systemPrompt: BETA }),
      first: { text: QUESTION },
    })
    costs.push(outcome.costs)
    evidence.push(...outcome.timeline.map(compact))
    const text = textOf(outcome.timeline)
    if (text.includes('MANGO')) memoryA = true
    tagA = tagOf(text)
    if (tagA !== 'none') break
  }

  const repo2 = ctx.newRepo('resume-2')
  const b = await runScenario({
    ctx,
    options: baseOptions(ctx, repo2, { resume: sid }),
    first: { text: QUESTION },
  })
  costs.push(b.costs)
  evidence.push(...b.timeline.map(compact))
  const memoryB = textOf(b.timeline).includes('MANGO')
  const subtypeB = b.results.at(-1)?.result?.subtype ?? 'none'

  observations.push(
    `attempts(a)=${attempts}`,
    `memory(a)=${memoryA}`,
    `tag(a)=${tagA}`,
    `memory(b)=${memoryB}`,
    `subtype(b)=${subtypeB}`,
    `error(b)=${b.error ?? 'none'}`,
  )

  if (!memoryA) {
    if (tagA === 'none') {
      return {
        ...META,
        status: 'NOT-RUN',
        reason: 'systemPrompt inconclusive',
        deviation: false,
        summary: '기억 미확인·systemPrompt 판정 불가',
        observations,
        evidence,
        attempts,
        costs,
      }
    }
    return {
      ...META,
      status: 'FAIL',
      deviation: false,
      summary: 'resume 후 기억 상실',
      observations,
      evidence,
      attempts,
      costs,
    }
  }
  if (tagA === 'BETA') {
    return {
      ...META,
      status: 'PASS',
      deviation: false,
      summary: 'resume 시 변경 systemPrompt 반영',
      observations,
      evidence,
      attempts,
      costs,
    }
  }
  if (tagA === 'ALPHA') {
    return {
      ...META,
      status: 'PASS',
      deviation: true,
      summary: 'resume 시 첫 systemPrompt 재사용',
      observations,
      evidence,
      attempts,
      costs,
    }
  }
  observations.push('systemPrompt 판정 불가')
  return {
    ...META,
    status: 'PASS',
    deviation: false,
    summary: 'resume 후 기억 유지 (systemPrompt 판정 불가)',
    observations,
    evidence,
    attempts,
    costs,
  }
}

export const item: SpikeItem = { ...META, adrs: 'ADR-10', live: true, estimateUsd: 0.3, run }

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
