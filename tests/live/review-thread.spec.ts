/**
 * Live review-thread check against the playground repository without a model: the product pull request writes
 * (githubPullRequests over GitHubApi) run with the agent token, opening a PR, re-opening it through the idempotent
 * head lookup, replying to an owner review comment and resolving its thread, reading push permission and closing the
 * PR. The owner side uses the harness gh. The branch agent/review-thread-<run> is left for pnpm live:cleanup. Gated by
 * ISSUECREW_LIVE=1, a configured ISSUECREW_LIVE_REPO and the two tokens; never prints a token.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Commands } from '../../src/infra/commands.ts'
import { GitHubApi } from '../../src/infra/github-api.ts'
import { githubPullRequests, type PullRequests } from '../../src/sources/github/delivery.ts'
import { daemonEnv, ghShim } from './gh-shim.ts'
import { ghJson } from './gh.ts'
import { assertAllowedRepo } from './guard.ts'
import { attributionProblems, commitProblems, contentProblems, runTag } from './rules.ts'
import { liveEnabled, liveTarget } from './target.ts'

const TARGET = liveTarget()
const LIVE = liveEnabled()
const AGENT_TOKEN = process.env.ISSUECREW_GITHUB_TOKEN?.trim()
const OWNER_TOKEN = process.env.ISSUECREW_LIVE_OWNER_TOKEN?.trim()
const REPO = TARGET ? assertAllowedRepo(TARGET.repo) : ''
const AGENT = TARGET?.agentLogin ?? ''
const TOKENS = [AGENT_TOKEN, OWNER_TOKEN].filter((token): token is string => Boolean(token))
const SHIM = ghShim()
const RUN = runTag()
const TITLE = 'Review thread check ' + RUN
const BODY = 'Checks review replies through the API client.'
const COMMIT = 'test: add review thread note'
const PATH_ = 'review-thread/' + RUN + '.md'
const BRANCH = 'agent/review-thread-' + RUN
const CONTENT = TITLE + '\n'
const COMMENT = 'Please confirm this line.'
const REPLY = 'Confirmed, resolving this thread.'
const CLOSE = 'Closing: the review thread check is done.'

const owner = (args: string[], input?: string): Promise<unknown> => ghJson(OWNER_TOKEN!, args, { input })

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

describe.skipIf(!LIVE || !AGENT_TOKEN || !OWNER_TOKEN)('live review thread', () => {
  let pr = 0
  let closed = false
  let prs: PullRequests
  const evidence: Record<string, unknown> = {}

  beforeAll(() => {
    prs = githubPullRequests(
      new Commands({
        baseEnv: daemonEnv(process.env, SHIM),
        client: new GitHubApi({ token: AGENT_TOKEN! }),
      }),
    )
  })

  afterAll(async () => {
    if (pr && !closed) await prs.close(REPO, pr, CLOSE).catch(() => undefined)
    evidence.ghShim = { bin: SHIM.bin, calls: SHIM.calls() }
    const serialized = JSON.stringify(evidence)
    expect(TOKENS.some(token => serialized.includes(token))).toBe(false)
    const outDir = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(
      join(outDir, `review-thread-${stamp(new Date())}.json`),
      JSON.stringify({ repo: REPO, ...evidence }, null, 2),
    )
    expect(SHIM.calls()).toEqual([])
  })

  it('posted texts carry no planning id or attribution', () => {
    const posted: [string, string][] = [
      ['title', TITLE],
      ['body', BODY],
      ['commit', COMMIT],
      ['comment', COMMENT],
      ['reply', REPLY],
      ['close', CLOSE],
      ['branch', BRANCH],
    ]
    for (const [label, value] of posted)
      expect([...contentProblems(label, value), ...attributionProblems(label, value)]).toEqual([])
    expect(commitProblems(COMMIT)).toEqual([])
  })

  it('the agent opens a PR, replies to a review comment and resolves its thread through the API client', async () => {
    const base = ((await owner(['repos/' + REPO])) as { default_branch: string }).default_branch
    const baseSha = ((await owner(['repos/' + REPO + '/git/ref/heads/' + base])) as { object: { sha: string } }).object
      .sha
    const baseCommit = (await owner(['repos/' + REPO + '/git/commits/' + baseSha])) as { tree: { sha: string } }
    const blob = (await owner(
      ['repos/' + REPO + '/git/blobs', '-X', 'POST', '--input', '-'],
      JSON.stringify({ content: Buffer.from(CONTENT, 'utf8').toString('base64'), encoding: 'base64' }),
    )) as { sha: string }
    const tree = (await owner(
      ['repos/' + REPO + '/git/trees', '-X', 'POST', '--input', '-'],
      JSON.stringify({
        base_tree: baseCommit.tree.sha,
        tree: [{ path: PATH_, mode: '100644', type: 'blob', sha: blob.sha }],
      }),
    )) as { sha: string }
    const commit = (await owner(
      ['repos/' + REPO + '/git/commits', '-X', 'POST', '--input', '-'],
      JSON.stringify({ message: COMMIT, tree: tree.sha, parents: [baseSha] }),
    )) as { sha: string }
    await owner(
      ['repos/' + REPO + '/git/refs', '-X', 'POST', '--input', '-'],
      JSON.stringify({ ref: 'refs/heads/' + BRANCH, sha: commit.sha }),
    )
    const headSha = commit.sha

    const request = { head: BRANCH, base, title: TITLE, body: BODY, draft: false }
    const first = await prs.open(REPO, request)
    expect(first.created).toBe(true)
    pr = first.number
    const again = await prs.open(REPO, request)
    expect(again.created).toBe(false)
    expect(again.number).toBe(pr)
    const pull = (await owner(['repos/' + REPO + '/pulls/' + pr])) as { user: { login: string }; state: string }
    expect(pull.user.login).toBe(AGENT)
    expect(pull.state).toBe('open')

    const comment = (await owner(
      ['repos/' + REPO + '/pulls/' + pr + '/comments', '-X', 'POST', '--input', '-'],
      JSON.stringify({ body: COMMENT, commit_id: headSha, path: PATH_, line: 1, side: 'RIGHT' }),
    )) as { id: number; html_url: string }

    const reply = await prs.replyReviewThread(REPO, pr, comment.id, REPLY, true)
    expect(reply.resolved).toBe(true)

    const replies = (await owner(['repos/' + REPO + '/pulls/' + pr + '/comments?per_page=100'])) as {
      id: number
      in_reply_to_id?: number | null
      html_url: string
      body: string
      user: { login: string }
    }[]
    const found = replies.filter(item => item.id === reply.replyId)
    expect(found).toHaveLength(1)
    expect(found[0]!.in_reply_to_id).toBe(comment.id)
    expect(found[0]!.user.login).toBe(AGENT)
    expect(found[0]!.body).toBe(REPLY)

    const threads = (await owner([
      'graphql',
      '-f',
      `query=query { repository(owner: ${JSON.stringify(TARGET!.owner)}, name: ${JSON.stringify(TARGET!.name)}) { pullRequest(number: ${pr}) { reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { databaseId } } } } } } }`,
    ])) as {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: { isResolved: boolean; comments: { nodes: { databaseId: number | null }[] } }[]
            }
          }
        }
      }
    }
    const thread = threads.data.repository.pullRequest.reviewThreads.nodes.find(
      node => node.comments.nodes[0]?.databaseId === comment.id,
    )
    expect(thread?.isResolved).toBe(true)

    const push = await prs.pushPermission(REPO)
    expect(push).toBe(true)

    await prs.close(REPO, pr, CLOSE)
    closed = true
    const closedPull = (await owner(['repos/' + REPO + '/pulls/' + pr])) as { state: string }
    expect(closedPull.state).toBe('closed')
    const issueComments = (await owner(['repos/' + REPO + '/issues/' + pr + '/comments?per_page=100'])) as {
      body: string
      user: { login: string }
    }[]
    expect(issueComments.some(item => item.user.login === AGENT && item.body === CLOSE)).toBe(true)

    Object.assign(evidence, {
      run: RUN,
      branch: BRANCH,
      pr: { number: pr, url: first.url, reopenCreated: again.created },
      comment: { id: comment.id, url: comment.html_url },
      reply: { id: reply.replyId, url: found[0]!.html_url },
      resolved: reply.resolved,
      pushPermission: push,
      closed,
    })
  })
})
