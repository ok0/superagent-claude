/** Worker delivery tools: publish opens one PR and binds it, review replies, auto-merge only when allowed, close without merge, and every policy refusal before any git or gh call. Runs against the scripted gh fixture. */
import { describe, expect, it, vi } from 'vitest'
import { deliveryTools, type DeliveryToolsHost } from '../src/app/tools/delivery.ts'
import type { ToolSpec } from '../src/executor/contract.ts'
import { githubPullRequests } from '../src/sources/github/delivery.ts'
import { fakeGh, pull, type FakeRepository } from './fixtures/fake-gh.ts'

const A = 'acme/widgets'
const signal = (): AbortSignal => new AbortController().signal

interface SetupOptions {
  follows?: { thread: string; own: boolean; closed?: { at: string; outcome: 'merged' | 'closed' } }[]
  allow?: boolean
  repositoryOf?: () => string
  ended?: boolean
}

function setup(opts: SetupOptions = {}) {
  const repo: FakeRepository = {
    pulls: {
      2: pull(A, 2, { node_id: 'PR_acme/widgets_2', state: 'open' }),
      5: pull(A, 5, { node_id: 'PR_acme/widgets_5', state: 'open' }),
    },
    reviewComments: {
      2: [{ id: 70, body: 'x', user: { login: 'alice' }, pull_request_url: `https://api.github.com/repos/${A}/pulls/2` }],
    },
  }
  const gh = fakeGh({ repositories: { [A]: repo } })
  const follows = opts.follows ?? [{ thread: 'github:acme/widgets#2', own: true }]
  const bindThread = vi.fn()
  const push = vi.fn(async () => ({ repository: A, branch: 'agent/x', base: 'main', head: 'h', pushed: 1, rewritten: 0, uncommitted: false }))
  const ended = { at: '2026-09-23T00:00:00Z', by: 'human', outcome: 'closed' }
  const host: DeliveryToolsHost = {
    engine: () => ({ bindThread }) as never,
    ticket: () => (opts.ended ? { ended, follows } : { follows }) as never,
    repositories: () => [A],
    delivery: {
      repositoryOf: opts.repositoryOf ?? (() => A),
      push,
      pulls: githubPullRequests(gh.commands),
      allowAutoMerge: () => opts.allow ?? false,
    },
  }
  const tools = deliveryTools(host, 'T1')
  return { gh, tools, bindThread, push }
}

function find(tools: ToolSpec[], name: string): ToolSpec {
  const found = tools.find(item => item.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

describe('worker delivery tools', () => {
  it('publish twice opens one PR, binds its thread own, and passes coAuthors', async () => {
    const { gh, tools, bindThread, push } = setup()
    const publish = find(tools, 'orchestrator_publish')
    const args = { title: 'Fix', body: 'Body', coAuthors: ['Ann <ann@example.com>'] }
    const first = await publish.execute(args, signal()) as { pr: number; created: boolean }
    const second = await publish.execute(args, signal()) as { pr: number; created: boolean }
    expect(first.created).toBe(true)
    expect(second).toMatchObject({ pr: first.pr, created: false })
    expect(gh.requests.filter(r => r.method === 'POST' && r.path === 'repos/acme/widgets/pulls')).toHaveLength(1)
    expect(bindThread).toHaveBeenCalledWith('T1', { source: 'github', id: `acme/widgets#${first.pr}` }, true)
    expect(push).toHaveBeenCalledWith('T1', { coAuthors: ['Ann <ann@example.com>'] })
  })

  it('publish rejects a malformed co-author with no push or gh call', async () => {
    const { gh, tools, push } = setup()
    const publish = find(tools, 'orchestrator_publish')
    await expect(publish.execute({ title: 'Fix', body: 'Body', coAuthors: ['ann'] }, signal())).rejects.toThrow()
    expect(push).not.toHaveBeenCalled()
    expect(gh.calls).toHaveLength(0)
  })

  it('review_reply posts one reply and resolves only on request', async () => {
    const { gh, tools } = setup()
    const reply = find(tools, 'orchestrator_review_reply')
    await reply.execute({ pr: 2, comment_id: 70, body: 'Done.', resolve: true }, signal())
    expect(gh.requests.filter(r => r.method === 'POST' && r.path === 'repos/acme/widgets/pulls/2/comments/70/replies')).toHaveLength(1)
    expect(gh.graphql.filter(g => g.query.includes('resolveReviewThread'))).toHaveLength(1)

    const graphqlBefore = gh.graphql.length
    await reply.execute({ pr: 2, comment_id: 70, body: 'Noted.' }, signal())
    expect(gh.requests.filter(r => r.method === 'POST' && r.path === 'repos/acme/widgets/pulls/2/comments/70/replies')).toHaveLength(2)
    expect(gh.graphql.length).toBe(graphqlBefore)
  })

  it('auto_merge is a tool error with no gh call while not allowed, and only enables auto-merge when allowed', async () => {
    const denied = setup({ allow: false })
    await expect(find(denied.tools, 'orchestrator_pr_auto_merge').execute({ pr: 2, method: 'squash' }, signal())).rejects.toThrow(/not allowed/)
    expect(denied.gh.calls).toHaveLength(0)

    const allowed = setup({ allow: true })
    await find(allowed.tools, 'orchestrator_pr_auto_merge').execute({ pr: 2, method: 'squash' }, signal())
    expect(allowed.gh.graphql.filter(g => g.query.includes('enablePullRequestAutoMerge'))).toHaveLength(1)
    expect(allowed.gh.requests.filter(r => r.path.includes('/merge'))).toHaveLength(0)
    expect(allowed.gh.graphql.filter(g => g.query.includes('mergePullRequest'))).toHaveLength(0)
  })

  it('pr_close closes a bound PR without merging', async () => {
    const { gh, tools } = setup()
    await find(tools, 'orchestrator_pr_close').execute({ pr: 2, reason: 'Superseded.' }, signal())
    expect(gh.requests.some(r => r.method === 'PATCH' && r.path === 'repos/acme/widgets/pulls/2' && r.fields.state === 'closed')).toBe(true)
    expect(gh.requests.filter(r => r.path.includes('/merge'))).toHaveLength(0)
  })

  it('refuses unbound PRs and unconfigured repositories with no gh call', async () => {
    const { gh, tools, push } = setup({ allow: true })
    const cases: [string, Record<string, unknown>][] = [
      ['orchestrator_review_reply', { pr: 5, comment_id: 70, body: 'x' }],
      ['orchestrator_review_reply', { pr: 2, comment_id: 70, body: 'x', repository: 'other/repo' }],
      ['orchestrator_pr_auto_merge', { pr: 5, method: 'merge' }],
      ['orchestrator_pr_auto_merge', { pr: 2, method: 'merge', repository: 'other/repo' }],
      ['orchestrator_pr_close', { pr: 5, reason: 'x' }],
      ['orchestrator_pr_close', { pr: 2, reason: 'x', repository: 'other/repo' }],
    ]
    for (const [name, args] of cases) await expect(find(tools, name).execute(args, signal())).rejects.toThrow()

    const context = setup({ allow: true, follows: [{ thread: 'github:acme/widgets#2', own: false }] })
    await expect(find(context.tools, 'orchestrator_pr_auto_merge').execute({ pr: 2, method: 'merge' }, signal())).rejects.toThrow(/not bound/)
    await expect(find(context.tools, 'orchestrator_pr_close').execute({ pr: 2, reason: 'x' }, signal())).rejects.toThrow(/not bound/)
    expect(context.gh.calls).toHaveLength(0)

    const other = setup({ repositoryOf: () => 'other/repo' })
    await expect(find(other.tools, 'orchestrator_publish').execute({ title: 'Fix', body: 'Body' }, signal())).rejects.toThrow(/not in the configured repositories/)
    expect(other.push).not.toHaveBeenCalled()

    expect(gh.calls).toHaveLength(0)
    expect(push).not.toHaveBeenCalled()
  })

  it('an ended ticket gets a tool error', async () => {
    const { gh, tools, push } = setup({ ended: true })
    await expect(find(tools, 'orchestrator_publish').execute({ title: 'Fix', body: 'Body' }, signal())).rejects.toThrow(/Ticket ended/)
    expect(push).not.toHaveBeenCalled()
    expect(gh.calls).toHaveLength(0)
  })
})
