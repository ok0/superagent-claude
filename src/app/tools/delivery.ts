/** The worker's host-side delivery tools: publish (push + PR, binds its Thread), review-thread reply, auto-merge, close. Policy is checked before any git or GitHub call: live ticket, configured repository, a PR this ticket bound, delivery.allowAutoMerge. Publish first re-checks push permission and returns published: false without any write when it is missing; repository access errors file a failed report. */
import { z } from 'zod'
import type { EngineForExecutor } from '../../core/index.ts'
import { liveTicket, type Ticket } from '../../core/model.ts'
import type { ToolSpec } from '../../executor/contract.ts'
import { CO_AUTHOR, RepositoryAccessError, accessStatus, type PushOptions, type PushResult } from '../../executor/workspaces.ts'
import { CliError } from '../../infra/commands.ts'
import type { PullRequests } from '../../sources/github/delivery.ts'
import { configured, threadId, threadKeyOf } from '../../sources/github/trigger.ts'
import { tool } from './tool.ts'

export interface DeliveryHost {
  repositoryOf(ticketId: string): string
  push(ticketId: string, options: PushOptions): Promise<PushResult>
  pulls?: PullRequests
  allowAutoMerge(): boolean
  /** The push permission recorded at startup (repo-access), undefined when none. */
  recordedPush?(repository: string): boolean | undefined
}

export interface DeliveryToolsHost {
  engine(): Pick<EngineForExecutor, 'bindThread' | 'report'>
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
  const ACCESS = new Set([401, 403, 404])
  const accessFailure = (repository: string, error: unknown): Error => {
    if (error instanceof Error && error.name === 'AbortError') return error
    const access = error instanceof RepositoryAccessError ? error
      : new RepositoryAccessError(repository, error instanceof Error ? error.message : String(error), accessStatus(error))
    host.engine().report(ticketId, { state: 'failed', summary: 'Publishing stopped: ' + access.message })
    return new Error(access.message + '. The host reported this ticket failed; do not report it again.')
  }
  const bound = (repository: string, pr: number, ownOnly: boolean): void => {
    const key = threadKeyOf(repository, pr).toLowerCase()
    const follow = host.ticket(ticketId)?.follows?.find(item => item.thread.toLowerCase() === key && !item.closed)
    if (!follow || (ownOnly && !follow.own)) throw new Error(`PR ${repository}#${pr} is not bound to this ticket`)
  }
  return [
    tool({
      name: 'orchestrator_publish',
      description: 'Push this ticket\'s commits and open its pull request, or reuse the open one for the branch; never force-pushes. Binds the PR thread to this ticket. Returns published: false, pushing nothing, when the agent account has no write access to the repository.',
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
        const recorded = deliveryHost().recordedPush?.(repository)
        let allowed: boolean
        try { allowed = await pullRequests.pushPermission(repository, signal) } catch (error) { throw accessFailure(repository, error) }
        if (!allowed) {
          return {
            published: false, repository,
            reason: `The agent account has no write access to ${repository}; write access is needed to publish, so nothing was pushed and no pull request was opened`,
            recorded_at_startup: recorded === undefined ? 'unknown' : recorded ? 'push' : 'no push',
            next: `Report blocked with one human_action asking a person to give the agent account write access to ${repository}`,
          }
        }
        let pushed: PushResult
        try {
          pushed = await deliveryHost().push(ticketId, { coAuthors: args.coAuthors })
        } catch (error) {
          throw error instanceof RepositoryAccessError ? accessFailure(repository, error) : error
        }
        let pr: Awaited<ReturnType<PullRequests['open']>>
        try {
          pr = await pullRequests.open(repository, { head: pushed.branch, base: pushed.base, title: args.title, body: args.body, draft: args.draft ?? false }, signal)
        } catch (error) {
          throw error instanceof CliError && error.code !== undefined && ACCESS.has(error.code) ? accessFailure(repository, error) : error
        }
        host.engine().bindThread(ticketId, { source: 'github', id: threadId(repository, pr.number) }, true)
        return {
          published: true, pr: pr.number, url: pr.url, created: pr.created, branch: pushed.branch, pushed_commits: pushed.pushed,
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
