/** Host-side pull request writes: one PR per branch (adopted when open), review-thread replies with resolve, auto-merge enabled but never merged, and close with a reason. Runs against the scripted gh fixture. */
import { describe, expect, it } from 'vitest'
import { CliError } from '../src/infra/commands.ts'
import { githubPullRequests } from '../src/sources/github/delivery.ts'
import { fakeGh, pull, type FakeRepository } from './fixtures/fake-gh.ts'

const A = 'acme/widgets'
const request = { head: 'agent/x', base: 'main', title: 'Title', body: 'Body', draft: false }

describe('github delivery', () => {
  it('opens one PR for a branch and adopts it on the next call', async () => {
    const gh = fakeGh({ repositories: { [A]: {} } })
    const pulls = githubPullRequests(gh.commands)
    const first = await pulls.open(A, request)
    const second = await pulls.open(A, request)
    expect(first).toMatchObject({ number: 1, created: true })
    expect(second).toEqual({ number: 1, url: first.url, created: false })
    expect(gh.requests.filter(r => r.method === 'POST' && r.path === 'repos/acme/widgets/pulls')).toHaveLength(1)
  })

  it('replies in the review thread of any of its comments and resolves it on request', async () => {
    const repo: FakeRepository = {
      pulls: { 3: pull(A, 3) },
      reviewComments: {
        3: [
          { id: 70, body: 'root', pull_request_url: `https://api.github.com/repos/${A}/pulls/3` },
          { id: 71, body: 'reply', in_reply_to_id: 70, pull_request_url: `https://api.github.com/repos/${A}/pulls/3` },
        ],
        4: [{ id: 80, body: 'other', pull_request_url: `https://api.github.com/repos/${A}/pulls/4` }],
      },
    }
    const gh = fakeGh({ repositories: { [A]: repo } })
    const pulls = githubPullRequests(gh.commands)

    const resolved = await pulls.replyReviewThread(A, 3, 71, 'Done.', true)
    expect(resolved.resolved).toBe(true)
    expect(
      gh.requests.filter(r => r.method === 'POST' && r.path === 'repos/acme/widgets/pulls/3/comments/70/replies'),
    ).toHaveLength(1)
    expect(gh.graphql.filter(g => g.query.includes('resolveReviewThread'))).toHaveLength(1)
    expect(repo.resolved?.has(70)).toBe(true)

    const graphqlBefore = gh.graphql.length
    const noted = await pulls.replyReviewThread(A, 3, 70, 'Noted.', false)
    expect(noted.resolved).toBe(false)
    expect(
      gh.requests.filter(r => r.method === 'POST' && r.path === 'repos/acme/widgets/pulls/3/comments/70/replies'),
    ).toHaveLength(2)
    expect(gh.graphql.length).toBe(graphqlBefore)

    await expect(pulls.replyReviewThread(A, 3, 80, 'x', false)).rejects.toThrow(/not a review comment on PR #3/)
  })

  it('reads the push permission of the agent account', async () => {
    const gh = fakeGh({ repositories: { [A]: { access: { push: false } }, 'acme/tools': {} } })
    const pulls = githubPullRequests(gh.commands)
    expect(await pulls.pushPermission(A)).toBe(false)
    expect(await pulls.pushPermission('acme/tools')).toBe(true)
    const denied = fakeGh({ repositories: { [A]: { access: { status: 404 } } } })
    const error = await githubPullRequests(denied.commands)
      .pushPermission(A)
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe(404)
  })

  it('enables auto-merge only', async () => {
    const repo: FakeRepository = { pulls: { 4: pull(A, 4, { node_id: 'PR_acme/widgets_4', state: 'open' }) } }
    const gh = fakeGh({ repositories: { [A]: repo } })
    const pulls = githubPullRequests(gh.commands)
    expect(await pulls.enableAutoMerge(A, 4, 'squash')).toEqual({ enabled: true })
    const auto = gh.graphql.filter(g => g.query.includes('enablePullRequestAutoMerge'))
    expect(auto).toHaveLength(1)
    expect(auto[0]!.variables.method).toBe('SQUASH')
    expect(gh.requests.filter(r => r.path.includes('/merge'))).toHaveLength(0)
    expect(gh.graphql.filter(g => g.query.includes('mergePullRequest'))).toHaveLength(0)
  })

  it('closes a PR with its reason and never merges', async () => {
    const repo: FakeRepository = { pulls: { 4: pull(A, 4) } }
    const gh = fakeGh({ repositories: { [A]: repo } })
    const pulls = githubPullRequests(gh.commands)
    expect(await pulls.close(A, 4, 'Superseded.')).toEqual({ closed: true })
    expect(
      gh.requests.some(
        r =>
          r.method === 'POST' && r.path === 'repos/acme/widgets/issues/4/comments' && r.fields.body === 'Superseded.',
      ),
    ).toBe(true)
    expect(
      gh.requests.some(
        r => r.method === 'PATCH' && r.path === 'repos/acme/widgets/pulls/4' && r.fields.state === 'closed',
      ),
    ).toBe(true)
    expect(gh.requests.filter(r => r.path.includes('merge'))).toHaveLength(0)
  })
})
