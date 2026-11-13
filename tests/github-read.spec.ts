// Ported from dsh-superagent-prototype (MIT) tests/github-read.spec.ts
/** GitHub resource and CI readers over a repository-scoped command runner. */
import { expect, it } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { GitHubApi } from '../src/infra/github-api.ts'
import { readGithub, pullChecks } from '../src/sources/github/read.ts'

const seen: string[] = []
let replies: { body: unknown; link?: string }[] = []
const fetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  seen.push(`${request.method} ${url.pathname.slice(1)}${url.search}`)
  const next = replies.shift() ?? { body: [] }
  return new Response(JSON.stringify(next.body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(next.link ? { link: next.link } : {}) },
  })
}
const serve = (...items: { body: unknown; link?: string }[]): void => {
  replies = items
  seen.length = 0
}
const commands = new Commands({ baseEnv: {}, client: new GitHubApi({ token: 't', fetch }) }).at('repos/acme/widgets')

it('reads a bounded comment page and exposes the next page reference', async () => {
  serve({ body: Array.from({ length: 20 }, (_, id) => ({ id, body: 'comment' })) })
  expect(await readGithub(commands, 'github/issues/123/comments/2')).toMatchObject({
    next_resource: 'github/issues/123/comments/3',
  })
  expect(seen).toEqual(['GET repos/acme/widgets/issues/123/comments?per_page=20&page=2'])
})

it('rejects unsupported or escaping paths without making a request', async () => {
  serve()
  for (const resource of [
    'github/../outside',
    'github/issues/1/reviews',
    'github/pulls/1/checks/2',
    'github/issues/1?repo=other',
  ]) {
    await expect(readGithub(commands, resource)).rejects.toThrow()
  }
  expect(seen).toEqual([])
})

it('reads checks across pages and canonicalizes the latest status per context', async () => {
  serve(
    {
      body: { check_runs: [{ name: 'z', status: 'completed', conclusion: 'success' }] },
      link: '<https://api.github.com/repos/acme/widgets/commits/abc/check-runs?per_page=100&page=2>; rel="next"',
    },
    { body: { check_runs: [{ name: 'a', status: 'in_progress', conclusion: null }] } },
    {
      body: [
        { context: 'build', state: 'success' },
        { context: 'build', state: 'failure' },
      ],
    },
  )
  const result = await pullChecks(commands, 'abc')
  expect(result.checks.map((check: { name: string }) => check.name)).toEqual(['a', 'z'])
  expect(result.statuses).toEqual([{ context: 'build', state: 'success' }])
})

it('reads any requested PR’s CI on demand without restricting the author', async () => {
  serve(
    { body: { head: { sha: 'abc' }, user: { login: 'another-author' } } },
    { body: { check_runs: [] } },
    { body: [] },
  )
  expect(await readGithub(commands, 'github/pulls/123/checks')).toEqual({ head: 'abc', checks: [], statuses: [] })
  expect(seen).toEqual([
    'GET repos/acme/widgets/pulls/123',
    'GET repos/acme/widgets/commits/abc/check-runs?per_page=100',
    'GET repos/acme/widgets/commits/abc/statuses?per_page=100',
  ])
})

/** Fake GitHub REST API pull request review comment payload. */
const reviewComment = (id: number, reply?: number) => ({
  id,
  url: `https://api.github.com/repos/acme/widgets/pulls/comments/${id}`,
  pull_request_review_id: 77,
  node_id: 'PRRC_x',
  path: 'src/render.ts',
  line: 43,
  original_line: 43,
  side: 'RIGHT',
  commit_id: 'abc',
  diff_hunk: '@@ -40,6 +40,8 @@\n   const title = view.title\n   const margin = 12\n+  const padding = 8',
  user: {
    login: id === 2 ? 'review-bot[bot]' : 'carol',
    id: 5,
    type: id === 2 ? 'Bot' : 'User',
    avatar_url: 'https://avatars/5',
    html_url: 'https://github.com/carol',
  },
  body: `comment ${id}`,
  created_at: `2026-09-09T00:00:0${id}Z`,
  updated_at: `2026-09-09T00:00:0${id}Z`,
  html_url: `https://github.com/acme/widgets/pull/9#discussion_r${id}`,
  author_association: 'MEMBER',
  reactions: { total_count: 0 },
  _links: { self: { href: 'x' } },
  ...(reply ? { in_reply_to_id: reply } : {}),
})
it('reads a page of review comments as messages: id, author, time, text, the comment each answers, and the file and line', async () => {
  serve({ body: [reviewComment(1), reviewComment(2, 1)] })
  expect(await readGithub(commands, 'github/pulls/9/comments/1')).toEqual({
    messages: [
      {
        id: '1',
        from: 'carol',
        at: '2026-09-09T00:00:01Z',
        text: 'comment 1',
        url: 'https://github.com/acme/widgets/pull/9#discussion_r1',
        path: 'src/render.ts',
        line: 43,
      },
      {
        id: '2',
        from: 'review-bot[bot]',
        at: '2026-09-09T00:00:02Z',
        text: 'comment 2',
        bot: true,
        reply_to: '1',
        url: 'https://github.com/acme/widgets/pull/9#discussion_r2',
        path: 'src/render.ts',
        line: 43,
      },
    ],
  })
})
it('reads a review thread from any of its comments, the first with its file, line and diff lines', async () => {
  serve({
    body: [reviewComment(3), reviewComment(2, 1), reviewComment(1), reviewComment(4, 3)].map(item => ({
      ...item,
      user: { login: item.user.login, type: item.user.type },
    })),
  })
  const thread = (await readGithub(commands, 'github/pulls/9/thread/2')) as {
    messages: { id: string; text: string; reply_to?: string }[]
  }
  expect(thread.messages.map(message => [message.id, message.reply_to])).toEqual([
    ['1', undefined],
    ['2', '1'],
  ])
  expect(thread.messages[0]!.text).toBe(
    'src/render.ts:43\n   const title = view.title\n   const margin = 12\n+  const padding = 8\n\ncomment 1',
  )
  serve()
  await expect(readGithub(commands, 'github/issues/9/thread/2')).rejects.toThrow('require a pull request')
})
it("reads an Issue or PR as its author, time, title, state, description and a PR's branches", async () => {
  serve({
    body: {
      number: 9,
      id: 1,
      title: 'Fix the margin',
      state: 'open',
      body: 'Details',
      draft: true,
      user: { login: 'carol', type: 'User' },
      created_at: '2026-09-09T00:00:00Z',
      html_url: 'https://github.com/acme/widgets/pull/9',
      head: { ref: 'agent/fix', sha: 'abc', repo: {} },
      base: { ref: 'main' },
      labels: [{ name: 'ui', color: 'fff' }],
      node_id: 'x',
      _links: {},
    },
  })
  expect(await readGithub(commands, 'github/pulls/9')).toEqual({
    number: 9,
    title: 'Fix the margin',
    state: 'open',
    draft: true,
    head: 'agent/fix',
    base: 'main',
    labels: ['ui'],
    id: '9',
    from: 'carol',
    at: '2026-09-09T00:00:00Z',
    text: 'Details',
    url: 'https://github.com/acme/widgets/pull/9',
  })
})
