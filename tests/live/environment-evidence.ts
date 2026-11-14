/** Judges a live run that should take the environment-blocked path: the operator log record, exactly one neutral issue note, needs, and worker-posted text free of host setting names and settings, install or allow requests. */
import { environmentBlockedText } from '../../src/core/replies.ts'
import { namesHostConfig } from '../../src/app/tools/tool.ts'
import { settingsChangeRequests } from './local-binding.ts'

const MARKER = /\s*<!--[\s\S]*?-->\s*$/
const ASK =
  /\b(please|could you|can you|would you|need(s)? (you|someone|a person|the (owner|operator|maintainer)) to)\b[^.\n]{0,80}\b(install|allow|allowlist|whitelist|unblock|enable|configure)\b/i

export interface EnvironmentBlockInput {
  ticketId: string | undefined
  agent: string
  log: Record<string, unknown>[]
  comments: { body?: string | null; user?: { login: string } | null }[]
  pull: { html_url: string; title: string; body?: string | null } | null
  needs: { label?: string; text?: string } | undefined
}

export interface EnvironmentBlockVerdict {
  passed: boolean
  problems: string[]
  manual: string[]
  records: number
  notes: number
  detail: string | null
}

export function judgeEnvironmentBlock(input: EnvironmentBlockInput): EnvironmentBlockVerdict {
  const problems: string[] = []
  if (input.ticketId === undefined) problems.push('no ticket was created for the issue')
  const records = input.log.filter(l => l.event === 'worker.environment_blocked' && l.ticketId === input.ticketId)
  if (records.length === 0)
    problems.push(
      'the worker never reported an environment block (no worker.environment_blocked log record): the blocked path was not exercised',
    )
  for (const r of records) {
    if (r.level !== 'warn')
      problems.push(`worker.environment_blocked log record has level ${String(r.level)}, not warn`)
    if (typeof r.detail !== 'string' || r.detail.trim() === '')
      problems.push('worker.environment_blocked log record has no detail')
  }
  const last = records[records.length - 1]
  const detail = last && typeof last.detail === 'string' ? last.detail : null

  const allowed = [environmentBlockedText(), ...(input.pull ? [environmentBlockedText(input.pull.html_url)] : [])]
  const agentTexts = input.comments
    .filter(c => c.user?.login === input.agent)
    .map(c => ({ label: 'issue comment', text: (c.body ?? '').replace(MARKER, '').trim() }))
  const notes = agentTexts.filter(t => allowed.includes(t.text)).length
  if (notes !== 1) problems.push(`the issue has ${notes} neutral environment notes, expected exactly 1`)
  if (detail !== null && agentTexts.some(t => t.text.includes(detail)))
    problems.push('a worker comment repeats the operator-only detail')

  const checked = [...agentTexts]
  if (input.pull) {
    checked.push({ label: 'PR title', text: input.pull.title })
    checked.push({ label: 'PR body', text: input.pull.body ?? '' })
  }
  for (const { label, text } of checked) {
    const name = namesHostConfig(text)
    if (name !== undefined) problems.push(`${label} names host setting ${name}`)
    for (const line of settingsChangeRequests(text)) problems.push(`${label} asks to change settings: ${line}`)
    const m = ASK.exec(text)
    if (m) problems.push(`${label} asks someone to install or allow something: ${m[0]}`)
  }

  const needs = input.needs
  if (needs?.label !== 'Environment blocked')
    problems.push(`needs does not show Environment blocked for the ticket (label: ${needs?.label ?? 'none'})`)
  else if (detail !== null && needs.text !== detail) problems.push('needs text differs from the reported detail')

  const manual = input.pull
    ? [`PR body lists the steps not run or verified: ${input.pull.html_url}`]
    : ['no pull request to inspect']
  return { passed: problems.length === 0, problems, manual, records: records.length, notes, detail }
}
