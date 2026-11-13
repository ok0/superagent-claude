import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
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
  json?: Record<string, unknown>
}[] = [
  { name: 'user', method: 'GET', path: 'user' },
  { name: 'repo access', method: 'GET', path: 'repos/acme/widgets' },
  { name: 'issue', method: 'GET', path: 'repos/acme/widgets/issues/1' },
  { name: 'comments list', method: 'GET', path: 'repos/acme/widgets/issues/1/comments' },
  {
    name: 'PR create',
    method: 'POST',
    path: 'repos/acme/widgets/pulls',
    json: { title: 'T', head: 'feat', base: 'main', body: 'B', draft: false },
  },
  {
    name: 'review reply',
    method: 'POST',
    path: 'repos/acme/widgets/pulls/2/comments/70/replies',
    json: { body: 'thanks' },
  },
  {
    name: 'graphql threads',
    method: 'POST',
    path: 'graphql',
    json: { query: 'query{reviewThreads}', variables: { owner: 'acme', name: 'widgets', number: 2 } },
  },
  {
    name: 'graphql resolve',
    method: 'POST',
    path: 'graphql',
    json: { query: 'mutation{resolveReviewThread}', variables: { id: 'RT_70' } },
  },
  {
    name: 'graphql auto-merge',
    method: 'POST',
    path: 'graphql',
    json: {
      query: 'mutation($method:PullRequestMergeMethod!){enablePullRequestAutoMerge}',
      variables: { id: 'PR_acme/widgets_2', method: 'SQUASH' },
    },
  },
]

describe('fetch adapter matches the routing core', () => {
  for (const item of cases) {
    it(item.name, async () => {
      const a = fakeGh(script())
      const b = fakeGh(script())
      const fields =
        item.path === 'graphql'
          ? { query: item.json!.query, ...(item.json!.variables as Record<string, unknown>) }
          : (item.json ?? {})
      const expected = a.answer(item.method, item.path, fields)
      expect(expected.status).toBe(200)
      const res = await b.fetch(
        new Request('https://api.github.com/' + item.path, {
          method: item.method,
          body: item.json ? JSON.stringify(item.json) : undefined,
          headers: { 'content-type': 'application/json' },
        }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(expected.data)
      if (item.name === 'PR create') {
        expect(b.requests.map(r => [r.method, r.path])).toEqual([['POST', 'repos/acme/widgets/pulls']])
        expect(b.requests[0]!.body).toEqual(item.json)
      }
    })
  }

  it('maps a missing issue to 404 in the core, the fetch adapter and Commands', async () => {
    const a = fakeGh(script())
    const b = fakeGh(script())
    expect(a.answer('GET', 'repos/acme/widgets/issues/99', {})).toEqual({
      status: 404,
      data: { message: 'Request failed' },
    })
    await expect(a.commands.get(z.unknown(), 'repos/acme/widgets/issues/99')).rejects.toMatchObject({ code: 404 })
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

  const PARENT = `import { spawnSync } from 'node:child_process'
const r = spawnSync(process.execPath, ['--input-type=module', '-e', process.env.CHILD_SOURCE], { env: process.env, encoding: 'utf8' })
console.log(JSON.stringify({ signal: r.signal }))`

  const run = (gh: ReturnType<typeof fileGh>) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
      env: { PATH: '/usr/bin:/bin', ...gh.env },
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

  it('keeps the parent running when the preload kills the child', () => {
    const gh = fileGh(mkdtempSync(join(tmpdir(), 'gh-kill-')), script())
    gh.kill({ when: 'beforePost', path: 'issues/1/comments' })
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', PARENT], {
      env: { PATH: '/usr/bin:/bin', ...gh.env, CHILD_SOURCE: CHILD },
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.status).toBe(0)
    expect(result.signal).toBeNull()
    const lines = result.stdout.trim().split('\n')
    expect(JSON.parse(lines[lines.length - 1]!)).toEqual({ signal: 'SIGKILL' })
    expect(gh.read().killed?.path).toBe('issues/1/comments')
  })

  it('no test fixture kills its parent process', () => {
    const dir = new URL('./fixtures/', import.meta.url)
    for (const name of readdirSync(dir).filter(file => file.endsWith('.ts'))) {
      expect(readFileSync(new URL(name, dir), 'utf8'), name).not.toContain('process.ppid')
    }
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
