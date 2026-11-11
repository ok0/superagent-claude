import { basename } from 'node:path'
import { isTestFile } from './rules.ts'

// Ambiguity check: question OR stated interpretation. A question counts when the agent asks it before the pull request. An interpretation counts when a file or component is named in the PR body, when an agent issue comment states the planned change (posted no later than 120 s after the PR), or when PR prose names visual properties or areas. Every arm is a cheap heuristic (keywords and sentence matching, no model call); false positives only make the check pass.
export interface IssueComment {
  user: { login: string }
  body?: string | null
  created_at: string
  html_url?: string
}
export const KOREAN_QUESTION_ENDINGS = ['까요', '나요', 'ㄹ까요', '습니까', '인가요', '있을까요', '할까요'] as const

// Cheap heuristic for Korean clarification requests that end in a request rather than a question mark or question ending.
// False positives only trigger one canned answer, and only for agent comments posted before the pull request.
const KOREAN_REQUEST_RE =
  /(?:알려|말씀)\s?(?:해\s?)?주(?:세요|시면|시겠|시기)|확인\s?(?:부탁|해\s?주)|주시면[^.!。…\n]*겠습니다/u

// Cheap heuristic for a stated intent or a description of a change.
export const INTENT_RE =
  /겠습니다|하겠|진행합니다|진행하겠|할 예정|할게요|\b(?:will|going to|I'll|I will|plan to|updated?|changed?|adjusted?|restyled?|tweaked?)\b/iu
// Cheap heuristic: Korean terms match as substrings, English terms as case-insensitive word prefixes.
export const AREA_TERMS = [
  '간격',
  '여백',
  '정렬',
  '색',
  '글꼴',
  '폰트',
  '레이아웃',
  '목록',
  '리스트',
  '행',
  '헤더',
  '화면',
  '스타일',
  '강조',
  '가독성',
  '테두리',
  '그림자',
  '크기',
] as const
export const AREA_TERMS_EN = [
  'spacing',
  'space',
  'padding',
  'margin',
  'color',
  'colour',
  'layout',
  'list',
  'row',
  'header',
  'font',
  'border',
  'shadow',
  'style',
  'styling',
  'css',
  'typography',
  'alignment',
  'contrast',
  'readab',
] as const
const AREA_EN_RE = new RegExp('\\b(?:' + AREA_TERMS_EN.join('|') + ')', 'i')

function hasArea(text: string): boolean {
  return AREA_TERMS.some(term => text.includes(term)) || AREA_EN_RE.test(text)
}

const COMMENT_SLACK_MS = 120_000

function keepProseLine(line: string): boolean {
  const t = line.trim()
  return !t.startsWith('>') && !/^(?:closes|fixes|resolves)\s+#\d+/i.test(t)
}

function keepBodyLine(line: string): boolean {
  const t = line.trim()
  return keepProseLine(line) && !/^[-*]\s*\[[ xX]\]/.test(t) && !/^(?:[-*]\s*)?`?npm\b/i.test(t)
}

function sentencesOf(text: string, keep: (line: string) => boolean): string[] {
  const kept = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .split(/\r?\n/)
    .filter(keep)
    .join('\n')
  return kept
    .split(/\n+|(?<=[.!?。])\s+/u)
    .map(s => s.trim())
    .filter(s => s !== '')
}

export function statesInterpretation(text: string): string | null {
  for (const sentence of sentencesOf(text, keepProseLine)) {
    if (sentence.length >= 12 && INTENT_RE.test(sentence) && hasArea(sentence)) return sentence
  }
  return null
}

export function prBodyInterpretation(body: string | null | undefined): string | null {
  for (const sentence of sentencesOf(body ?? '', keepBodyLine)) {
    if (hasArea(sentence) && (INTENT_RE.test(sentence) || sentence.length >= 20)) return sentence
  }
  return null
}

export function isQuestionLine(line: string): boolean {
  let t = line.trim()
  if (t === '' || t.startsWith('>') || /^<!--.*-->$/.test(t)) return false
  t = t.replace(/[*_`'")\]]+$/u, '').trimEnd()
  if (/[?？]$/.test(t)) return true
  return /(?:있을까요|할까요|ㄹ까요|인가요|습니까|까요|나요)[.!。…~]*$/u.test(t) || KOREAN_REQUEST_RE.test(t)
}

export function questionLines(text: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (!fenced && isQuestionLine(line)) out.push(line)
  }
  return out
}

export function agentQuestion(
  comments: readonly IssueComment[],
  agent: string,
  before?: string,
): { comment: IssueComment; line: string } | null {
  for (const c of comments) {
    if (c.user.login.toLowerCase() !== agent.toLowerCase()) continue
    if (before !== undefined && !(Date.parse(c.created_at) < Date.parse(before))) continue
    const line = questionLines(c.body ?? '')[0]
    if (line !== undefined) return { comment: c, line }
  }
  return null
}

function agentReplies(comments: readonly IssueComment[], agent: string): IssueComment[] {
  return comments.filter(
    c =>
      c.user.login.toLowerCase() === agent.toLowerCase() &&
      !(c.body ?? '').trimStart().startsWith('<!-- superagent-claude:'),
  )
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function interpretationMentions(prBody: string | null | undefined, changedFiles: readonly string[]): string[] {
  const body = (prBody ?? '').replace(/<!--[\s\S]*?-->/g, '')
  const names = new Set<string>()
  for (const f of changedFiles) {
    names.add(basename(f))
    if (/\.[jt]sx$/.test(f) && !isTestFile(f)) names.add(basename(f).replace(/\.[^.]+$/, ''))
  }
  return [...names].filter(name => new RegExp('(?<![\\w.-])' + escapeRe(name) + '(?![\\w-])').test(body)).sort()
}

export interface AmbiguityVerdict {
  passed: boolean
  via: 'question' | 'interpretation' | null
  question: string | null
  mentions: string[]
  source?: 'comment' | 'pr-body' | 'file-mention' | null
  statement?: string | null
}

export function judgeAmbiguity(
  comments: readonly IssueComment[],
  pr: { body: string | null | undefined; createdAt: string },
  changedFiles: readonly string[],
  agent: string,
): AmbiguityVerdict {
  const q = agentQuestion(comments, agent, pr.createdAt)
  const mentions = interpretationMentions(pr.body, changedFiles)
  if (q) return { passed: true, via: 'question', question: q.line, mentions, source: 'comment', statement: null }
  if (mentions.length > 0)
    return { passed: true, via: 'interpretation', question: null, mentions, source: 'file-mention', statement: null }
  const prCreated = Date.parse(pr.createdAt)
  for (const c of comments) {
    if (c.user.login.toLowerCase() !== agent.toLowerCase()) continue
    if (!(Date.parse(c.created_at) <= prCreated + COMMENT_SLACK_MS)) continue
    const statement = statesInterpretation(c.body ?? '')
    if (statement !== null)
      return { passed: true, via: 'interpretation', question: null, mentions: [], source: 'comment', statement }
  }
  const statement = prBodyInterpretation(pr.body)
  if (statement !== null)
    return { passed: true, via: 'interpretation', question: null, mentions: [], source: 'pr-body', statement }
  return { passed: false, via: null, question: null, mentions: [], source: null, statement: null }
}

export interface PullWait<P> {
  pull: P
  asked: boolean
  question: string | null
  answerUrl: string | null
}

export async function waitForPull<P extends { created_at: string }>(o: {
  answer?: string
  agent: string
  comments: () => Promise<readonly IssueComment[]>
  postAnswer: (body: string) => Promise<{ html_url: string }>
  findPull: () => Promise<P | undefined>
  timeoutMs: number
  stepMs: number
  sleep: (ms: number) => Promise<void>
  now?: () => number
  graceMs?: number
}): Promise<PullWait<P>> {
  const now = o.now ?? Date.now
  const deadline = now() + o.timeoutMs
  const graceMs = o.graceMs ?? 600_000
  let answered: string | null = null
  let asked = false
  let question: string | null = null
  let repliedAt: number | null = null
  for (;;) {
    const pull = await o.findPull()
    const comments = await o.comments()
    const q = agentQuestion(comments, o.agent, pull?.created_at)
    if (q) {
      asked = true
      question ??= q.line
    }
    if (repliedAt === null && agentReplies(comments, o.agent).length > 0) repliedAt = now()
    if (pull) return { pull, asked, question, answerUrl: answered }
    if (q && o.answer !== undefined && answered === null) {
      answered = (await o.postAnswer(o.answer)).html_url
      repliedAt = now()
    }
    if (repliedAt !== null && now() - repliedAt >= graceMs) {
      const last = agentReplies(comments, o.agent).at(-1)?.body ?? ''
      throw new Error(
        'agent replied on the issue but opened no pull request within ' +
          graceMs +
          ' ms' +
          (answered !== null ? ' after the canned answer' : '') +
          ': ' +
          last.slice(0, 200),
      )
    }
    if (now() >= deadline)
      throw new Error(
        asked
          ? 'no pull request within ' + o.timeoutMs + ' ms after the agent asked a question'
          : 'no pull request within ' + o.timeoutMs + ' ms',
      )
    await o.sleep(o.stepMs)
  }
}
