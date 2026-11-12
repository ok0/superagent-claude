// Ported from dsh-superagent-prototype (MIT) src/sources/github-trigger.ts
/**
 * Normalizes GitHub issues, pull requests, comments, reviews, review comments and CI transitions into domain Triggers.
 * Thread, trigger and channel keys include the repository (Thread id <owner>/<name>#<number>).
 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../../core/index.ts'
import { escapeRegExp } from '../../infra/text.ts'
import { sameName } from '../../policy/actors.ts'

export const SOURCE = 'github'
/** The kind has no config keys; `{}` parses, so the kind is enabled under the Runtime's empty configs reader. */
export const GithubConfigSchema = z.record(z.string(), z.never())
export type GithubConfig = Record<string, never>
export const threadId = (repository: string, number: number): string => `${repository}#${number}`
export const threadKeyOf = (repository: string, number: number): string => `${SOURCE}:${threadId(repository, number)}`
export function parseThreadId(id: string): { repository: string; number: number } | undefined {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(id)
  return match ? { repository: match[1]!, number: Number(match[2]) } : undefined
}
export const configured = (repositories: readonly string[], name: string): string | undefined =>
  repositories.find(item => sameName(item, name))
/** GitHub reply address: issue/PR conversation, or a review thread when `url` points at a discussion comment. */
export const githubChannel = (repository: string, number: number, url?: string): ChannelRef => ({
  source: SOURCE,
  thread: threadKeyOf(repository, number),
  address: { repository, number: String(number), ...(url ? { url } : {}) },
})
export const githubPage = (repository: string, number: number, pr = false): string =>
  `https://github.com/${repository}/${pr ? 'pull' : 'issues'}/${number}`
/** Parses an Issue, PR, or review-comment URL in a configured repository; undefined for anything else. */
export function githubAddress(
  url: string,
  repositories: readonly string[],
): { repository: string; number: number; pr: boolean; discussion?: number } | undefined {
  const address =
    /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i
  const match = address.exec(url)
  if (!match) return undefined
  const repository = configured(repositories, match[1]!)
  if (!repository) return undefined
  return {
    repository,
    number: Number(match[3]),
    pr: match[2]!.toLowerCase() !== 'issues',
    ...(match[4] ? { discussion: Number(match[4]) } : {}),
  }
}
/** GitHub returns a deleted account as `null` and displays it as `ghost`. */
export const UserSchema = z
  .looseObject({ login: z.string(), type: z.string().optional() })
  .nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
/** A GitHub comment or review; `in_reply_to_id` is the root comment ID of its review thread. */
export const CommentSchema = z.looseObject({
  id: z.number(),
  body: z.string().nullish(),
  user: UserSchema,
  html_url: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  submitted_at: z.string().nullish(),
  state: z.string().nullish(),
  commit_id: z.string().nullish(),
  path: z.string().nullish(),
  line: z.number().nullish(),
  original_line: z.number().nullish(),
  diff_hunk: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type GithubComment = z.infer<typeof CommentSchema>
/** GitHub sets `pull_request` when the number is a pull request. */
export const IssueSchema = CommentSchema.extend({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  created_at: z.string(),
  html_url: z.string(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
export type GithubIssue = z.infer<typeof IssueSchema>
type Opened = Pick<GithubIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
export interface PullRef {
  repository: string
  number: number
  isPr: boolean
  url?: string
  prAuthor?: string
}
/** Review bots under ordinary user accounts count as human here; the prompts identify automated accounts. */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/i.test(user.login) && (!user.type || user.type === 'User')
export function reviewPlace(comment: GithubComment): string {
  const line = comment.line ?? comment.original_line
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  return [`${comment.path}${line != null ? `:${line}` : ''}`, hunk].filter(Boolean).join('\n')
}
function commentText(comment: GithubComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: { login: string; type?: string }, agent: string) => ({
  actor: { source: SOURCE, id: user.login },
  human: isHumanLogin(user) && !sameName(user.login, agent),
})
/** Text is empty for a bodyless comment or a `COMMENTED` review without a body. */
export function commentTrigger(
  comment: GithubComment,
  ref: PullRef,
  kind: 'conversation' | 'inline' | 'review',
  agent: string,
): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const id = key(
    'github-comment',
    ref.repository,
    comment.html_url ?? threadKeyOf(ref.repository, ref.number),
    String(comment.id),
    version,
  )
  return {
    id,
    source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(ref.repository, ref.number) }],
    ...author(comment.user, agent),
    at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(ref.repository, ref.number, comment.html_url ?? undefined),
    ...((comment.html_url ?? ref.url) ? { url: comment.html_url ?? ref.url } : {}),
    meta: {
      repository: ref.repository,
      number: ref.number,
      isPr: ref.isPr,
      ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}),
      commentId: comment.id,
      kind,
      ...(comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {}),
      ...(comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {}),
    },
  }
}
/** The ID matches the one used when Issue bodies were stored earlier, so stored bodies are not ingested again. */
export function issueTrigger(issue: Opened, repository: string, agent: string): Trigger {
  const body = issue.body ?? ''
  return {
    id: key('github-issue', repository, String(issue.number)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(repository, issue.number) }],
    ...author(issue.user, agent),
    at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(repository, issue.number, issue.html_url),
    url: issue.html_url,
    meta: { repository, number: issue.number, isPr: false, kind: 'issue' },
  }
}
/** PR and Issue numbers never collide, so the PR trigger reuses `issueTrigger`'s `github-issue` ID. */
export function pullTrigger(pull: Opened, repository: string, agent: string): Trigger {
  return {
    ...issueTrigger(pull, repository, agent),
    meta: { repository, number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' },
  }
}
export function ciTrigger(
  repository: string,
  pr: { number: number; html_url: string; user: { login: string } },
  revision: number,
  summary: string,
  at: string,
): Trigger {
  return {
    id: key('github-ci', repository, String(pr.number), String(revision)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(repository, pr.number) }],
    actor: { source: SOURCE, id: '' },
    human: false,
    at,
    text: summary,
    channel: githubChannel(repository, pr.number),
    url: pr.html_url,
    meta: { repository, number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision },
  }
}
