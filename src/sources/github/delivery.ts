/** Host-side pull request writes under the agent account: open or adopt the PR of a branch, reply in a review thread and resolve it, enable auto-merge (never merge), close a PR. Only gh api REST and graphql calls. */
import { z } from 'zod'
import type { Commands } from '../../infra/commands.ts'
import { repositoryCommands } from './read.ts'

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export interface PullRequests {
  open(repository: string, request: { head: string; base: string; title: string; body: string; draft: boolean }, signal?: AbortSignal): Promise<{ number: number; url: string; created: boolean }>
  replyReviewThread(repository: string, pr: number, commentId: number, body: string, resolve: boolean, signal?: AbortSignal): Promise<{ replyId: number; resolved: boolean }>
  enableAutoMerge(repository: string, pr: number, method: MergeMethod, signal?: AbortSignal): Promise<{ enabled: true }>
  close(repository: string, pr: number, reason: string, signal?: AbortSignal): Promise<{ closed: true }>
}

const PullLite = z.looseObject({ number: z.number(), html_url: z.string(), head: z.looseObject({ ref: z.string() }) })
const ReviewComment = z.looseObject({ id: z.number(), in_reply_to_id: z.number().nullish(), pull_request_url: z.string() })
const ReplyCreated = z.looseObject({ id: z.number() })
const NodeLite = z.looseObject({ node_id: z.string(), state: z.string() })
const Threads = z.looseObject({
  data: z.looseObject({
    repository: z.looseObject({
      pullRequest: z.looseObject({
        reviewThreads: z.looseObject({
          nodes: z.array(z.looseObject({
            id: z.string(),
            isResolved: z.boolean(),
            comments: z.looseObject({ nodes: z.array(z.looseObject({ databaseId: z.number().nullish() })) }),
          })),
        }),
      }),
    }),
  }),
})

const THREADS = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}'
const RESOLVE = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}'
const AUTO = 'mutation($id:ID!,$method:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method}){pullRequest{number}}}'

export function githubPullRequests(commands: Commands): PullRequests {
  return {
    async open(repository, request, signal) {
      const scoped = repositoryCommands(commands.withSignal(signal), repository)
      const owner = repository.split('/')[0] ?? ''
      const open = await scoped.api(z.array(PullLite), `pulls?state=open&head=${owner}:${request.head}&per_page=10`)
      const existing = open.find(pull => pull.head.ref === request.head)
      if (existing) return { number: existing.number, url: existing.html_url, created: false }
      const created = await scoped.api(PullLite, 'pulls', '--method', 'POST', '-f', 'title=' + request.title, '-f', 'head=' + request.head, '-f', 'base=' + request.base, '-f', 'body=' + request.body, '-F', 'draft=' + String(request.draft))
      return { number: created.number, url: created.html_url, created: true }
    },

    async replyReviewThread(repository, pr, commentId, body, resolve, signal) {
      const root = commands.withSignal(signal)
      const scoped = repositoryCommands(root, repository)
      const comment = await scoped.api(ReviewComment, `pulls/comments/${commentId}`)
      if (!comment.pull_request_url.endsWith('/pulls/' + pr)) throw new Error(`Comment ${commentId} is not a review comment on PR #${pr}`)
      const rootId = comment.in_reply_to_id ?? comment.id
      const reply = await scoped.api(ReplyCreated, `pulls/${pr}/comments/${rootId}/replies`, '--method', 'POST', '-f', 'body=' + body)
      if (resolve) {
        const [owner = '', name = ''] = repository.split('/')
        const data = await root.api(Threads, 'graphql', '-f', 'query=' + THREADS, '-f', 'owner=' + owner, '-f', 'name=' + name, '-F', 'number=' + pr)
        const thread = data.data.repository.pullRequest.reviewThreads.nodes.find(node => node.comments.nodes[0]?.databaseId === rootId)
        if (!thread) throw new Error(`The review thread of comment ${rootId} was not found; the reply was posted`)
        if (!thread.isResolved) await root.api(z.unknown(), 'graphql', '-f', 'query=' + RESOLVE, '-f', 'id=' + thread.id)
      }
      return { replyId: reply.id, resolved: resolve }
    },

    async enableAutoMerge(repository, pr, method, signal) {
      const root = commands.withSignal(signal)
      const scoped = repositoryCommands(root, repository)
      const pull = await scoped.api(NodeLite, `pulls/${pr}`)
      if (pull.state !== 'open') throw new Error('PR #' + pr + ' is not open')
      await root.api(z.unknown(), 'graphql', '-f', 'query=' + AUTO, '-f', 'id=' + pull.node_id, '-f', 'method=' + method.toUpperCase())
      return { enabled: true }
    },

    async close(repository, pr, reason, signal) {
      const scoped = repositoryCommands(commands.withSignal(signal), repository)
      await scoped.api(z.unknown(), `issues/${pr}/comments`, '--method', 'POST', '-f', 'body=' + reason)
      await scoped.api(z.unknown(), 'pulls/' + pr, '--method', 'PATCH', '-f', 'state=closed')
      return { closed: true }
    },
  }
}
