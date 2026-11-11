import type { ItemResult, SpikeContext, SpikeItem } from '../lib/types.ts'
import { isMain } from '../lib/types.ts'
import { baseOptions, compact, field, runScenario, type TimelineEntry } from '../lib/session.ts'

const META = { id: 'disallowed-tools', req: 'R17', title: 'disallowedTools 도구 제거' }
const REMOVED = ['AskUserQuestion', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'NotebookEdit', 'Bash']

function toolsOf(init: Record<string, unknown> | undefined): string[] {
  const tools = field(init, 'tools')
  return Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string') : []
}

function toolUseNames(entries: TimelineEntry[]): string[] {
  return entries.flatMap(e => (e.toolUses ?? []).map(u => u.name))
}

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const observations: string[] = []
  const evidence: string[] = []

  const repo1 = ctx.newRepo('disallowed-1')
  const s1 = await runScenario({
    ctx,
    options: baseOptions(ctx, repo1, { disallowedTools: REMOVED }),
    first: { text: 'Use the AskUserQuestion tool to ask me which color I like. If you cannot, reply exactly NOASK.' },
    onEntry: (e, c) => {
      if (e.type === 'result') c.end()
    },
  })
  evidence.push(...s1.timeline.map(compact))

  const repo2 = ctx.newRepo('disallowed-control')
  const s2 = await runScenario({
    ctx,
    options: baseOptions(ctx, repo2, { disallowedTools: [] }),
    first: { text: 'Reply with exactly OK' },
    onEntry: (e, c) => {
      if (e.type === 'result') c.end()
    },
  })
  evidence.push(...s2.timeline.map(compact))

  const repo3 = ctx.newRepo('disallowed-control-ask')
  const s3 = await runScenario({
    ctx,
    options: baseOptions(ctx, repo3, { disallowedTools: [] }),
    first: {
      text: 'Use ToolSearch with query "select:AskUserQuestion" and report whether it matched; reply MATCHED or NOMATCH.',
    },
    onEntry: (e, c) => {
      if (e.type === 'result') c.end()
    },
  })
  evidence.push(...s3.timeline.map(compact))

  const costs = [s1.costs, s2.costs, s3.costs]
  if (s1.init === undefined) {
    return {
      ...META,
      status: 'FAIL',
      deviation: false,
      summary: '세션 1 init 없음 — 도구 목록 확인 불가',
      observations,
      evidence,
      attempts: 1,
      costs,
    }
  }
  observations.push(
    `apiKeySource=${String(field(s1.init, 'apiKeySource'))}`,
    `cliVersion=${String(field(s1.init, 'claude_code_version'))}`,
  )

  const tools1 = toolsOf(s1.init)
  const toolsControl = toolsOf(s2.init)
  const removedPresent = REMOVED.filter(name => tools1.includes(name))
  const usedRemoved = toolUseNames(s1.timeline).filter(name => REMOVED.includes(name))
  const controlOk = ['Bash', 'Write', 'WebFetch'].every(n => toolsControl.includes(n))
  const controlAskInInit = toolsControl.includes('AskUserQuestion')
  const controlAskReply = s3.results.at(-1)?.result?.resultText ?? ''
  const controlAskToolUseIds = s3.timeline.flatMap(e =>
    (e.toolUses ?? []).filter(u => u.name === 'ToolSearch').map(u => u.id),
  )
  const controlAskToolResults = s3.timeline.flatMap(e =>
    (e.toolResults ?? []).filter(r => controlAskToolUseIds.includes(r.toolUseId)),
  )
  const controlAskMatch =
    controlAskToolResults.some(r => !r.content.includes('No matching deferred tools found')) ||
    controlAskReply.includes('MATCHED')

  observations.push(
    `session1 tools=${tools1.length}`,
    `session1 removed-present=${removedPresent.length === 0 ? 'none' : removedPresent.join(',')}`,
    `session1 removed-tool_use=${usedRemoved.length === 0 ? 'none' : usedRemoved.join(',')}`,
    `control tools=${toolsControl.length}`,
    `control has Bash,Write,WebFetch=${controlOk}`,
    `control init has AskUserQuestion=${controlAskInInit}`,
    `control AskUserQuestion reachable=${controlAskMatch}`,
  )

  let status: 'PASS' | 'FAIL' = 'PASS'
  let summary = controlAskMatch
    ? 'REMOVED 도구 전부 제거 확인, 대조군 정상, AskUserQuestion 도달 가능성 대조군으로 확인'
    : 'REMOVED 도구 전부 제거 확인, 대조군 정상'
  if (!controlOk) {
    status = 'FAIL'
    summary = 'control invalid'
  } else if (removedPresent.length > 0) {
    status = 'FAIL'
    summary = `REMOVED 도구가 init 목록에 존재: ${removedPresent.join(',')}`
  } else if (usedRemoved.length > 0) {
    status = 'FAIL'
    summary = `REMOVED 도구 호출 관측: ${usedRemoved.join(',')}`
  }
  if (status === 'PASS' && !controlAskMatch) {
    summary += '; AskUserQuestion is not offered in headless mode by default; the disallow is redundant but harmless'
  }

  return {
    ...META,
    status,
    deviation: status === 'PASS' && !controlAskMatch,
    summary,
    observations,
    evidence,
    attempts: 1,
    costs,
  }
}

export const item: SpikeItem = { ...META, adrs: 'ADR-7', live: true, estimateUsd: 0.15, run }

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
