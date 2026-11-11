// Ported from dsh-superagent-prototype (MIT) src/sources/github-pull.ts
/** Pull request reads keyed by repository, and lifecycle observation with the auto-merge fact. Changes from the reference: pull requests and their Threads are keyed by repository; reads take repository-scoped commands; ticket binding (claiming a PR), agent-branch matching and chat notices are removed (delivery milestones). */
import { z } from 'zod'
import type { ThreadFact, Ticket } from '../../core/index.ts'
import type { Commands } from '../../infra/commands.ts'
import { sameName } from '../../policy/actors.ts'
import type { SourceContext } from '../host.ts'
import { parseThreadId, SOURCE, threadId, threadKeyOf, UserSchema } from './trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(),
  state: z.string(),
  html_url: z.string(),
  user: UserSchema,
  body: z.string().nullish(),
  created_at: z.string().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { repository: string; number: number }
export const readPull = async (commands: Commands, repository: string, number: number): Promise<Pull> => ({
  ...(await commands.api(PullSchema, `pulls/${number}`)),
  repository,
  number,
})
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

export const pullsOf = (ticket: Pick<Ticket, 'follows'>, repository: string, open = false): number[] =>
  (ticket.follows ?? [])
    .filter(item => (!open || !item.closed) && item.thread.startsWith(`${SOURCE}:`))
    .flatMap(item => {
      const parsed = parseThreadId(item.thread.slice(SOURCE.length + 1))
      return parsed && sameName(parsed.repository, repository) ? [parsed.number] : []
    })

export function observePull(ctx: Pick<SourceContext, 'tickets' | 'threads'>, pr: Pull, now: () => number): boolean {
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended && ctx.tickets.open().some(ticket => pullsOf(ticket, pr.repository, true).includes(pr.number))) {
    ctx.tickets.threadClosed(
      { source: SOURCE, id: threadId(pr.repository, pr.number) },
      pr.merged ? 'merged' : 'closed',
      pr.merged_at ?? pr.closed_at ?? new Date(now()).toISOString(),
    )
  }
  ctx.threads.describe(threadKeyOf(pr.repository, pr.number), {
    facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null },
  })
  return ended
}
