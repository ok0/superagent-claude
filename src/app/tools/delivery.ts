/** The worker's host-side delivery tools: publish (push + PR, binds its Thread), review-thread reply, auto-merge, close. Policy is checked before any git or GitHub call: live ticket, configured repository, a PR this ticket bound, delivery.allowAutoMerge. */
import { z } from 'zod'
import type { EngineForExecutor } from '../../core/index.ts'
import { liveTicket, type Ticket } from '../../core/model.ts'
import type { ToolSpec } from '../../executor/contract.ts'
import { CO_AUTHOR, type PushOptions, type PushResult } from '../../executor/workspaces.ts'
import type { PullRequests } from '../../sources/github/delivery.ts'
import { configured, threadId, threadKeyOf } from '../../sources/github/trigger.ts'
import { tool } from './tool.ts'

export interface DeliveryHost {
  repositoryOf(ticketId: string): string
  push(ticketId: string, options: PushOptions): Promise<PushResult>
  pulls?: PullRequests
  allowAutoMerge(): boolean
}

export interface DeliveryToolsHost {
  engine(): Pick<EngineForExecutor, 'bindThread'>
  ticket(id: string): Pick<Ticket, 'ended' | 'follows'> | undefined
  repositories?(): readonly string[]
  delivery?: DeliveryHost
}

export function deliveryTools(host: DeliveryToolsHost, ticketId: string): ToolSpec[] {
  const live = (): void => {
    const current = host.ticket(ticketId)
    if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
  }
  const deliveryHost = (): DeliveryHost => {
    if (!host.delivery) throw new Error('Pull request delivery is not available in this session')
    return host.delivery
  }
  const pulls = (): PullRequests => {
    const found = deliveryHost().pulls
    if (!found) throw new Error('Pull request delivery is not available in this session')
    return found
  }
  const repo = (name: string): string => {
    const found = configured(host.repositories?.() ?? [], name)
    if (!found) throw new Error(`Repository ${name} is not in the configured repositories`)
    return found
  }
  const bound = (repository: string, pr: number, ownOnly: boolean): void => {
    const key = threadKeyOf(repository, pr).toLowerCase()
    const follow = host.ticket(ticketId)?.follows?.find(item => item.thread.toLowerCase() === key && !item.closed)
    if (!follow || (ownOnly && !follow.own)) throw new Error(`PR ${repository}#${pr} is not bound to this ticket`)
  }
  return [
    tool({
      name: 'orchestrator_publish',
      description: 'Push this ticket\'s commits and open its pull request, or reuse the open one for the branch; never force-pushes. Binds the PR thread to this ticket.',
      schema: z.object({
        title: z.string().trim().min(1).max(256),
        body: z.string().trim().min(1).max(60000),
        draft: z.boolean().optional(),
        coAuthors: z.array(z.string().regex(CO_AUTHOR, 'A co-author is Name <email>')).max(10).optional(),
      }).strict(),
      execute: async (args, signal) => {
        live()
        const pullRequests = pulls()
        const repository = repo(deliveryHost().repositoryOf(ticketId))
        const pushed = await deliveryHost().push(ticketId, { coAuthors: args.coAuthors })
        const pr = await pullRequests.open(repository, { head: pushed.branch, base: pushed.base, title: args.title, body: args.body, draft: args.draft ?? false }, signal)
        host.engine().bindThread(ticketId, { source: 'github', id: threadId(repository, pr.number) }, true)
        return {
          pr: pr.number, url: pr.url, created: pr.created, branch: pushed.branch, pushed_commits: pushed.pushed,
          co_authored_commits: pushed.rewritten, uncommitted_changes: pushed.uncommitted,
        }
      },
    }),
    tool({
      name: 'orchestrator_review_reply',
      description: 'Reply in a review thread of a pull request this ticket follows, by the GitHub id of any comment in that thread, and optionally resolve the thread.',
      schema: z.object({
        pr: z.number().int().positive(),
        comment_id: z.number().int().positive().describe('GitHub id of any comment in the review thread, as github/pulls/<n>/comments or #discussion_r<id> shows'),
        body: z.string().trim().min(1).max(8000),
        resolve: z.boolean().optional(),
        repository: z.string().optional(),
      }).strict(),
      execute: async (args, signal) => {
        live()
        const pullRequests = pulls()
        const repository = repo(args.repository ?? deliveryHost().repositoryOf(ticketId))
        bound(repository, args.pr, false)
        const reply = await pullRequests.replyReviewThread(repository, args.pr, args.comment_id, args.body, args.resolve === true, signal)
        return { replied: true, reply_id: reply.replyId, resolved: reply.resolved }
      },
    }),
    tool({
      name: 'orchestrator_pr_auto_merge',
      description: 'Enable auto-merge on a pull request this ticket opened, so GitHub merges it once its requirements pass. It only enables auto-merge and never merges directly.',
      schema: z.object({
        pr: z.number().int().positive(),
        method: z.enum(['merge', 'squash', 'rebase']),
        repository: z.string().optional(),
      }).strict(),
      execute: async (args, signal) => {
        live()
        const pullRequests = pulls()
        if (!deliveryHost().allowAutoMerge()) throw new Error('Auto-merge is not allowed in this deployment (delivery.allowAutoMerge is false); a person merges this PR')
        const repository = repo(args.repository ?? deliveryHost().repositoryOf(ticketId))
        bound(repository, args.pr, true)
        await pullRequests.enableAutoMerge(repository, args.pr, args.method, signal)
        return { auto_merge: 'enabled', method: args.method }
      },
    }),
    tool({
      name: 'orchestrator_pr_close',
      description: 'Close a pull request this ticket opened without merging it, after a comment with the reason.',
      schema: z.object({
        pr: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1000),
        repository: z.string().optional(),
      }).strict(),
      execute: async (args, signal) => {
        live()
        const pullRequests = pulls()
        const repository = repo(args.repository ?? deliveryHost().repositoryOf(ticketId))
        bound(repository, args.pr, true)
        await pullRequests.close(repository, args.pr, args.reason, signal)
        return { closed: true, pr: args.pr }
      },
    }),
  ]
}
