import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CliError } from '../src/infra/commands.ts'
import { installFakeFetch } from './fixtures/cli.ts'
import { comment, fakeGh, issue, pull, type FakeGhScript } from './fixtures/fake-gh.ts'
import { fileGh } from './fixtures/file-gh.ts'

const script = (): FakeGhScript => ({
  repositories: {
    'acme/widgets': {
      issues: { 1: issue('acme/widgets', 1) },
      comments: { 1: [comment('acme/widgets', 1, 10)] },
      pulls: { 2: pull('acme/widgets', 2, { node_id: 'PR_acme/widgets_2' }) },
      reviewComments: { 2: [{ id: 70, body: 'root', user: { login: 'carol', type: 'User' } }] },
    },
  },
})

const cases: {
  name: string
  method: string
  path: string
  flags: string[]
  json?: Record<string, unknown>
}[] = [
  { name: 'user', method: 'GET', path: 'user', flags: [] },
  { name: 'repo access', method: 'GET', path: 'repos/acme/widgets', flags: [] },
  { name: 'issue', method: 'GET', path: 'repos/acme/widgets/issues/1', flags: [] },
  { name: 'comments list', method: 'GET', path: 'repos/acme/widgets/issues/1/comments', flags: [] },
  {
    name: 'PR create',
    method: 'POST',
    path: 'repos/acme/widgets/pulls',
    flags: [
      '--method',
      'POST',
      '-f',
      'title=T',
      '-f',
      'head=feat',
      '-f',
      'base=main',
      '-f',
      'body=B',
      '-F',
      'draft=false',
    ],
    json: { title: 'T', head: 'feat', base: 'main', body: 'B', draft: false },
  },
  {
    name: 'review reply',
    method: 'POST',
    path: 'repos/acme/widgets/pulls/2/comments/70/replies',
    flags: ['--method', 'POST', '-f', 'body=thanks'],
    json: { body: 'thanks' },
  },
  {
    name: 'graphql threads',
    method: 'POST',
    path: 'graphql',
    flags: ['-f', 'query=query{reviewThreads}', '-f', 'owner=acme', '-f', 'name=widgets', '-F', 'number=2'],
    json: { query: 'query{reviewThreads}', variables: { owner: 'acme', name: 'widgets', number: 2 } },
  },
  {
    name: 'graphql resolve',
    method: 'POST',
    path: 'graphql',
    flags: ['-f', 'query=mutation{resolveReviewThread}', '-f', 'id=RT_70'],
    json: { query: 'mutation{resolveReviewThread}', variables: { id: 'RT_70' } },
  },
  {
    name: 'graphql auto-merge',
    method: 'POST',
    path: 'graphql',
    flags: [
      '-f',
      'query=mutation($method:PullRequestMergeMethod!){enablePullRequestAutoMerge}',
      '-f',
      'id=PR_acme/widgets_2',
      '-f',
      'method=SQUASH',
    ],
    json: {
      query: 'mutation($method:PullRequestMergeMethod!){enablePullRequestAutoMerge}',
      variables: { id: 'PR_acme/widgets_2', method: 'SQUASH' },
    },
  },
]

describe('fetch and exec adapters agree', () => {
  for (const item of cases) {
    it(item.name, async () => {
      const a = fakeGh(script())
      const b = fakeGh(script())
      const exec = JSON.parse(await a.commands.api(item.path, ...item.flags)) as unknown
      const res = await b.fetch(
        new Request('https://api.github.com/' + item.path, {
          method: item.method,
          body: item.json ? JSON.stringify(item.json) : undefined,
          headers: { 'content-type': 'application/json' },
        }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(exec)
      if (item.name === 'PR create') {
        expect(b.requests.map(r => [r.method, r.path])).toEqual(a.requests.map(r => [r.method, r.path]))
      }
    })
  }

  it('maps a missing issue to the same 404 on both adapters', async () => {
    const a = fakeGh(script())
    const b = fakeGh(script())
    await expect(a.commands.api('repos/acme/widgets/issues/99')).rejects.toMatchObject({ code: 404 })
    const res = await b.fetch(new Request('https://api.github.com/repos/acme/widgets/issues/99'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ message: 'Request failed' })
  })
})

describe('child preload', () => {
  const CHILD = `
const r = await fetch('https://api.github.com/user')
console.log(JSON.stringify(await r.json()))
await fetch('https://api.github.com/repos/acme/widgets/issues/1/comments', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ body: 'hi' }),
})
console.log('survived')
`

  const run = (gh: ReturnType<typeof fileGh>) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
      env: { PATH: process.env.PATH ?? '', ...gh.env },
      encoding: 'utf8',
      timeout: 30_000,
    })

  it('SIGKILLs the child before a matching POST', () => {
    const gh = fileGh(mkdtempSync(join(tmpdir(), 'gh-kill-')), script())
    gh.kill({ when: 'beforePost', path: 'issues/1/comments' })
    const result = run(gh)
    expect(result.signal).toBe('SIGKILL')
    expect(result.stdout).toContain('"login":"agent-bot"')
    expect(result.stdout).not.toContain('survived')
    expect(gh.read().killed?.path).toBe('issues/1/comments')
    expect(gh.read().posted).toHaveLength(0)
  })

  it('SIGKILLs the child after a matching POST', () => {
    const gh = fileGh(mkdtempSync(join(tmpdir(), 'gh-kill-')), script())
    gh.kill({ when: 'afterPost', path: 'issues/1/comments' })
    const result = run(gh)
    expect(gh.read().posted).toHaveLength(1)
    expect(gh.read().posted[0]!.body).toBe('hi')
    expect(gh.read().killed).toBeDefined()
    expect(result.signal).toBe('SIGKILL')
  })

  it('lets the child finish without a kill rule', () => {
    const gh = fileGh(mkdtempSync(join(tmpdir(), 'gh-kill-')), script())
    const result = run(gh)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('survived')
    expect(gh.read().posted).toHaveLength(1)
  })
})

describe('in-process fake fetch', () => {
  it('answers user, repo access and inaccessible repos, then restores', async () => {
    const fake = installFakeFetch({ login: 'robot', inaccessible: ['acme/secret'] })
    try {
      const user = await fetch('https://api.github.com/user')
      expect(await user.json()).toMatchObject({ login: 'robot' })
      expect((await fetch('https://api.github.com/repos/acme/secret')).status).toBe(404)
      expect(await (await fetch('https://api.github.com/repos/acme/widgets')).json()).toMatchObject({
        permissions: { push: true },
      })
      expect(fake.requests).toContain('GET user')
    } finally {
      fake.restore()
    }
    await expect(fetch('https://api.github.com/user')).rejects.toThrow(/network guard/)
  })

  it('answers 401 for user when failUser is set', async () => {
    const fake = installFakeFetch({ failUser: true })
    try {
      expect((await fetch('https://api.github.com/user')).status).toBe(401)
    } finally {
      fake.restore()
    }
  })
})
