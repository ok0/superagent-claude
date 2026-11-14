import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult, Runner } from './live/gh.ts'
import { runCleanup } from './live/cleanup-playground.ts'
import { loadSeed, runSeed } from './live/seed-playground.ts'
import { SEED_MESSAGES, SEED_VERSION_PATH, WORKFLOW_PATH, blobSha, commitProblems, seedPlan } from './live/rules.ts'
import { assertApiTarget } from './live/guard.ts'
import { clearLiveTarget, EXAMPLE_TARGET_ENV, stubLiveTarget } from './fixtures/live-target.ts'

beforeEach(() => stubLiveTarget(EXAMPLE_TARGET_ENV))
afterEach(() => vi.unstubAllEnvs())

interface Call {
  endpoint: string
  method: string
  input?: string
  args: readonly string[]
  local: boolean
}

function result(body: unknown): RunResult {
  return { code: 0, stdout: Buffer.from(JSON.stringify(body)), stderr: '' }
}

function failure(stderr: string): RunResult {
  return { code: 1, stdout: Buffer.alloc(0), stderr }
}

function methodOf(args: readonly string[]): string {
  const index = args.indexOf('-X')
  return index >= 0 ? (args[index + 1] ?? 'GET') : 'GET'
}

function makeRunner(route: (call: Call) => RunResult, calls: Call[]): Runner {
  return async (args, env, input) => {
    const call: Call = {
      endpoint: args[1] ?? '',
      method: methodOf(args),
      input,
      args,
      local: env.GH_TOKEN === undefined,
    }
    calls.push(call)
    return route(call)
  }
}

function isWrite(call: Call): boolean {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(call.method)
}

function seedRemote(files: { path: string; sha: string }[]) {
  return files.map(file => ({ path: file.path, type: 'blob', sha: file.sha }))
}

interface SeedRoute {
  repoStatus?: number
  localLogin?: string | null
  localScopes: string[]
  remote: { path: string; type: string; sha: string }[] | 'empty'
  actionsEnabled?: boolean
  history?: { sha: string; commit: { message: string } }[]
  commitPulls?: Record<string, unknown[]>
  pulls?: Record<string, unknown>
  archived?: boolean
  tokenLogin?: string | null
}

function seedRunner(opts: SeedRoute) {
  const calls: Call[] = []
  let blobCount = 0
  let putCount = 0
  const P = EXAMPLE_TARGET_ENV.ISSUECREW_LIVE_REPO
  const repoStatus = opts.repoStatus ?? 200
  const localLogin = opts.localLogin === undefined ? 'example-owner' : opts.localLogin
  const run = makeRunner(call => {
    const { endpoint, method } = call
    if (endpoint === 'user') {
      if (!call.local) {
        if (opts.tokenLogin === null) return failure('HTTP 401')
        return result({ login: opts.tokenLogin === undefined ? 'example-owner' : opts.tokenLogin })
      }
      if (localLogin === null) return failure('gh: not logged in')
      return {
        code: 0,
        stdout: Buffer.from(
          'HTTP/2 200\r\nx-oauth-scopes: ' + opts.localScopes.join(', ') + '\r\n\r\n{"login":"' + localLogin + '"}',
        ),
        stderr: '',
      }
    }
    if (endpoint === 'repos/' + P && call.args.includes('--silent'))
      return repoStatus === 200 ? result({}) : failure('gh: Not Found (HTTP ' + repoStatus + ')')
    if (endpoint === 'repos/' + P + '/actions/permissions') return result({ enabled: opts.actionsEnabled ?? true })
    if (endpoint.startsWith('repos/' + P + '/actions/runs'))
      return result({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] })
    if (endpoint === 'repos/' + P) return result({ default_branch: 'main', archived: opts.archived ?? false })
    if (endpoint === 'repos/' + P + '/git/ref/heads/main') {
      if (opts.remote === 'empty') return failure('gh: Git Repository is empty. (HTTP 409)')
      return result({ object: { sha: 'h1' } })
    }
    if (endpoint === 'repos/' + P + '/git/commits/h1') return result({ tree: { sha: 't1' } })
    if (endpoint === 'repos/' + P + '/git/trees/t1?recursive=1')
      return result({ truncated: false, tree: opts.remote === 'empty' ? [] : opts.remote })
    if (endpoint.startsWith('repos/' + P + '/contents/') && method === 'PUT') {
      putCount += 1
      return result({ commit: { sha: 'k' + putCount, tree: { sha: 'kt' + putCount } } })
    }
    if (endpoint === 'repos/' + P + '/git/blobs' && method === 'POST') {
      blobCount += 1
      return result({ sha: 'b' + blobCount })
    }
    if (endpoint === 'repos/' + P + '/git/trees' && method === 'POST') return result({ sha: 't2' })
    if (endpoint === 'repos/' + P + '/git/commits' && method === 'POST') return result({ sha: 'c1' })
    if (endpoint === 'repos/' + P + '/git/refs/heads/main' && method === 'PATCH') return result({})
    if (endpoint === 'repos/' + P + '/commits?sha=h1&per_page=50')
      return result(opts.history ?? [{ sha: 'h1', commit: { message: 'docs: edit the notes by hand' } }])
    const commitPulls = /^repos\/example\/playground\/commits\/([^/]+)\/pulls$/.exec(endpoint)
    if (commitPulls) return result(opts.commitPulls?.[commitPulls[1] ?? ''] ?? [])
    const pullRead = /^repos\/example\/playground\/pulls\/(\d+)$/.exec(endpoint)
    if (pullRead) {
      const body = opts.pulls?.[pullRead[1] ?? '']
      if (body === undefined) throw new Error('unexpected pull: ' + endpoint)
      return result(body)
    }
    throw new Error('unexpected call: ' + method + ' ' + endpoint)
  }, calls)
  return { run, calls }
}

const OLD_SEED = [
  { path: 'package.json', sha: 'old-pkg' },
  { path: 'src/text.js', sha: 'old-src' },
  { path: 'test/text.test.js', sha: 'old-test' },
]
const ciSha = (): string => blobSha(loadSeed(true).find(file => file.path === WORKFLOW_PATH)!.content)

function seedOptions(overrides: SeedRoute & { withoutCi: boolean; upgrade?: boolean }) {
  const { run, calls } = seedRunner(overrides)
  const lines: string[] = []
  return {
    calls,
    lines,
    options: {
      token: 'token-under-test',
      withoutCi: overrides.withoutCi,
      upgrade: overrides.upgrade,
      run,
      out: (line: string) => lines.push(line),
      recordDir: mkdtempSync(join(tmpdir(), 'live-seed-')),
      pollMs: 1,
      ciTimeoutMs: 1000,
    },
  }
}

const P = EXAMPLE_TARGET_ENV.ISSUECREW_LIVE_REPO

function emptyRepositoryWrites(): string[] {
  const expected = loadSeed(false)
  return [
    'PUT repos/' + P + '/contents/' + loadSeed(false)[0]!.path,
    ...expected.slice(1).map(() => 'POST repos/' + P + '/git/blobs'),
    'POST repos/' + P + '/git/trees',
    'POST repos/' + P + '/git/commits',
    'PATCH repos/' + P + '/git/refs/heads/main',
  ]
}

describe('live seed', () => {
  it('BLOCKED without the workflow scope makes no write call', async () => {
    const { options, calls, lines } = seedOptions({ localScopes: ['repo'], remote: [], withoutCi: false })
    const code = await runSeed(options)
    expect(code).toBe(3)
    expect(lines).toContain('STATUS: BLOCKED')
    expect(lines).toContain('missing: workflow-scope')
    expect(lines.some(line => line.includes('gh auth refresh'))).toBe(true)
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('BLOCKED when the repository is unreachable, even with --without-ci', async () => {
    const { options, calls, lines } = seedOptions({
      repoStatus: 404,
      localScopes: ['repo', 'workflow'],
      remote: [],
      withoutCi: true,
    })
    const code = await runSeed(options)
    expect(code).toBe(3)
    expect(lines).toContain('missing: repo-access')
    expect(calls.filter(isWrite)).toHaveLength(0)
    expect(calls.some(call => call.endpoint === 'repos/' + P + '/actions/permissions')).toBe(false)
    expect(calls.some(call => call.endpoint.includes('/git/ref'))).toBe(false)
  })

  it('BLOCKED when local gh is another account', async () => {
    const { options, calls, lines } = seedOptions({
      localLogin: 'someone',
      localScopes: ['repo', 'workflow'],
      remote: [],
      withoutCi: false,
    })
    const code = await runSeed(options)
    expect(code).toBe(3)
    expect(lines).toContain('missing: local-gh-account')
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('unchanged seed makes no commit', async () => {
    const remote = seedRemote([
      ...loadSeed(true).map(file => ({ path: file.path, sha: blobSha(file.content) })),
      { path: 'NOTES.md', sha: 'notes-sha' },
    ])
    const { options, calls, lines } = seedOptions({ localScopes: ['repo', 'workflow'], remote, withoutCi: false })
    const code = await runSeed(options)
    expect(code).toBe(0)
    expect(lines).toContain('STATUS: UNCHANGED head=h1')
    expect(lines.some(line => line.startsWith('CI: success'))).toBe(true)
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('different content is reported, not overwritten', async () => {
    const remote = seedRemote([{ path: 'api/src/http/cursor.ts', sha: 'not-the-expected-sha' }])
    const { options, calls, lines } = seedOptions({ localScopes: ['repo', 'workflow'], remote, withoutCi: false })
    const code = await runSeed(options)
    expect(code).toBe(1)
    expect(lines).toContain('STATUS: DIFF')
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('empty repository with --without-ci: contents first commit, then one git-data commit', async () => {
    const { options, calls, lines } = seedOptions({
      localScopes: ['repo', 'workflow'],
      remote: 'empty',
      withoutCi: true,
    })
    const code = await runSeed(options)
    expect(code).toBe(0)
    expect(lines).toContain('REPO: empty')
    expect(lines).toContain('CI: skipped by --without-ci')

    const writes = calls.filter(isWrite)
    expect(writes.map(call => call.method + ' ' + call.endpoint)).toEqual(emptyRepositoryWrites())
    expect(writes.every(call => call.local === false)).toBe(true)

    const expected = loadSeed(false)
    const put = JSON.parse(writes[0]?.input ?? '{}') as { message: string; content: string; branch?: string }
    expect(commitProblems(put.message)).toEqual([])
    expect('branch' in put).toBe(false)
    expect(Buffer.from(put.content, 'base64').toString('utf8')).toBe(expected[0]?.content)

    const treeCall = writes.find(call => call.endpoint.endsWith('/git/trees'))
    const tree = JSON.parse(treeCall?.input ?? '{}') as { base_tree: string; tree: { path: string }[] }
    expect(tree.base_tree).toBe('kt1')
    expect(tree.tree.map(entry => entry.path)).toEqual(expected.slice(1).map(file => file.path))

    const commitCall = writes.find(call => call.endpoint.endsWith('/git/commits'))
    const commit = JSON.parse(commitCall?.input ?? '{}') as { parents: string[] }
    expect(commit.parents).toEqual(['k1'])

    const refCall = writes.find(call => call.endpoint.endsWith('/git/refs/heads/main'))
    expect(JSON.parse(refCall?.input ?? '{}')).toEqual({ sha: 'c1', force: false })
    expect(calls.some(call => call.endpoint.includes('/actions/runs'))).toBe(false)
  })

  it('without-ci and no workflow scope labels CI blocked and still seeds the package', async () => {
    const { options, calls, lines } = seedOptions({ localScopes: ['repo'], remote: 'empty', withoutCi: true })
    const code = await runSeed(options)
    expect(code).toBe(0)
    expect(lines).toContain('CI: BLOCKED(no-workflow-scope)')
    const writes = calls.filter(isWrite)
    expect(writes.map(call => call.method + ' ' + call.endpoint)).toEqual(emptyRepositoryWrites())
    expect(writes.some(call => call.local)).toBe(false)
  })

  it('adds only the workflow through the local gh credential', async () => {
    const remote = seedRemote([
      ...loadSeed(false).map(file => ({ path: file.path, sha: blobSha(file.content) })),
      { path: 'NOTES.md', sha: 'notes-sha' },
    ])
    const { options, calls, lines } = seedOptions({ localScopes: ['repo', 'workflow'], remote, withoutCi: false })
    const code = await runSeed(options)
    expect(code).toBe(0)

    const writes = calls.filter(isWrite)
    expect(writes.map(call => call.method + ' ' + call.endpoint)).toEqual([
      'PUT repos/' + P + '/contents/' + WORKFLOW_PATH,
    ])
    expect(writes[0]?.local).toBe(true)
    const put = JSON.parse(writes[0]?.input ?? '{}') as { message: string; branch: string; content: string }
    expect(put).toMatchObject({ message: 'ci: add test workflow', branch: 'main' })
    expect(Buffer.from(put.content, 'base64').toString('utf8')).toBe(
      loadSeed(true).find(file => file.path === WORKFLOW_PATH)?.content,
    )
    expect(
      calls.some(call => call.endpoint.startsWith('repos/' + P + '/actions/runs?head_sha=k1') && call.local === false),
    ).toBe(true)
    expect(lines.some(line => line.startsWith('CI: success'))).toBe(true)
  })

  it('full flow on an empty repository adds the package with the owner token and the workflow with local gh', async () => {
    const { options, calls, lines } = seedOptions({
      localScopes: ['repo', 'workflow'],
      remote: 'empty',
      withoutCi: false,
    })
    const code = await runSeed(options)
    expect(code).toBe(0)

    const writes = calls.filter(isWrite)
    expect(writes[0]).toMatchObject({
      method: 'PUT',
      endpoint: 'repos/' + P + '/contents/' + loadSeed(false)[0]!.path,
      local: false,
    })
    expect(writes[writes.length - 1]).toMatchObject({
      method: 'PUT',
      endpoint: 'repos/' + P + '/contents/' + WORKFLOW_PATH,
      local: true,
    })
    const patch = writes.findIndex(call => call.method === 'PATCH')
    expect(patch).toBeGreaterThanOrEqual(0)
    expect(patch).toBeLessThan(writes.length - 1)
    expect(lines.filter(line => line.startsWith('commit:'))).toHaveLength(3)
  })

  it('no call reaches a repository other than the playground', async () => {
    for (const withoutCi of [true, false]) {
      const { options, calls } = seedOptions({ localScopes: ['repo', 'workflow'], remote: 'empty', withoutCi })
      await runSeed(options)
      for (const call of calls) {
        if (call.endpoint === 'user') continue
        expect(call.endpoint.startsWith('repos/' + P)).toBe(true)
      }
    }
  })
})

describe('live seed upgrade', () => {
  const upgradeRemote = (files: { path: string; sha: string }[]) => seedRemote(files)

  it('same seed version is a no-op', async () => {
    const remote = upgradeRemote(loadSeed(true).map(file => ({ path: file.path, sha: blobSha(file.content) })))
    const { options, calls, lines } = seedOptions({
      localScopes: ['repo', 'workflow'],
      remote,
      withoutCi: false,
      upgrade: true,
    })
    const code = await runSeed(options)
    expect(code).toBe(0)
    expect(lines).toContain('STATUS: UNCHANGED head=h1')
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('replaces an older seed in one commit and leaves the workflow alone', async () => {
    const remote = upgradeRemote([...OLD_SEED, { path: WORKFLOW_PATH, sha: ciSha() }])
    const { options, calls, lines } = seedOptions({
      localScopes: ['repo', 'workflow'],
      remote,
      withoutCi: false,
      upgrade: true,
    })
    const code = await runSeed(options)
    expect(code).toBe(0)
    expect(lines).toContain('STATUS: UPGRADED commits=1 head=c1')

    const expected = loadSeed(false)
    const writes = calls.filter(isWrite)
    expect(writes.map(call => call.method + ' ' + call.endpoint)).toEqual([
      ...expected.map(() => 'POST repos/' + P + '/git/blobs'),
      'POST repos/' + P + '/git/trees',
      'POST repos/' + P + '/git/commits',
      'PATCH repos/' + P + '/git/refs/heads/main',
    ])
    expect(writes.every(call => call.local === false)).toBe(true)
    expect(writes.some(call => call.input?.includes('"force":true'))).toBe(false)

    const treeCall = writes.find(call => call.endpoint.endsWith('/git/trees'))
    const tree = JSON.parse(treeCall?.input ?? '{}') as {
      base_tree: string
      tree: { path: string; sha: string | null }[]
    }
    expect(tree.base_tree).toBe('t1')
    expect(tree.tree.find(entry => entry.path === 'src/text.js')?.sha).toBeNull()
    expect(tree.tree.find(entry => entry.path === 'test/text.test.js')?.sha).toBeNull()
    expect(tree.tree.some(entry => entry.path.startsWith('.github/workflows/'))).toBe(false)
    expect(tree.tree.find(entry => entry.path === 'package.json')?.sha).not.toBeNull()

    const commitCall = writes.find(call => call.endpoint.endsWith('/git/commits'))
    const commit = JSON.parse(commitCall?.input ?? '{}') as { message: string; parents: string[] }
    expect(commit.parents).toEqual(['h1'])
    expect(commitProblems(commit.message)).toEqual([])

    const refCall = writes.find(call => call.endpoint.endsWith('/git/refs/heads/main'))
    expect(JSON.parse(refCall?.input ?? '{}')).toEqual({ sha: 'c1', force: false })

    expect(lines.filter(line => line.startsWith('removed: '))).toEqual([
      'removed: src/text.js',
      'removed: test/text.test.js',
    ])
  })

  it('a changed workflow goes through local gh as a separate commit', async () => {
    const remote = upgradeRemote([...OLD_SEED, { path: WORKFLOW_PATH, sha: 'old-ci' }])
    const { options, calls, lines } = seedOptions({
      localScopes: ['repo', 'workflow'],
      remote,
      withoutCi: false,
      upgrade: true,
    })
    const code = await runSeed(options)
    expect(code).toBe(0)

    const writes = calls.filter(isWrite)
    const last = writes[writes.length - 1]
    expect(last).toMatchObject({ method: 'PUT', endpoint: 'repos/' + P + '/contents/' + WORKFLOW_PATH, local: true })
    expect(JSON.parse(last?.input ?? '{}')).toMatchObject({
      message: 'ci: install, typecheck and test every workspace',
      branch: 'main',
      sha: 'old-ci',
    })
    const put = JSON.parse(last?.input ?? '{}') as { content: string }
    expect(Buffer.from(put.content, 'base64').toString('utf8')).toBe(
      loadSeed(true).find(file => file.path === WORKFLOW_PATH)?.content,
    )
    expect(lines.filter(line => line.startsWith('commit:'))).toHaveLength(2)
    expect(lines.some(line => line.startsWith('CI: success'))).toBe(true)
  })

  it('--without-ci leaves a changed workflow untouched', async () => {
    const remote = upgradeRemote([...OLD_SEED, { path: WORKFLOW_PATH, sha: 'old-ci' }])
    const { options, calls } = seedOptions({
      localScopes: ['repo', 'workflow'],
      remote,
      withoutCi: true,
      upgrade: true,
    })
    await runSeed(options)
    const writes = calls.filter(isWrite)
    expect(writes.some(call => call.endpoint.includes('.github/workflows'))).toBe(false)
    expect(writes.some(call => call.local)).toBe(false)
  })

  it('without --upgrade an older seed is reported, not replaced', async () => {
    const remote = upgradeRemote(OLD_SEED)
    const { options, calls, lines } = seedOptions({ localScopes: ['repo', 'workflow'], remote, withoutCi: false })
    const code = await runSeed(options)
    expect(code).toBe(1)
    expect(lines).toContain('STATUS: DIFF')
    expect(lines.some(line => line.includes('--upgrade'))).toBe(true)
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('upgrade stays inside the playground', async () => {
    const scenarios = [
      upgradeRemote([...OLD_SEED, { path: WORKFLOW_PATH, sha: ciSha() }]),
      upgradeRemote([...OLD_SEED, { path: WORKFLOW_PATH, sha: 'old-ci' }]),
    ]
    for (const remote of scenarios) {
      const { options, calls } = seedOptions({
        localScopes: ['repo', 'workflow'],
        remote,
        withoutCi: false,
        upgrade: true,
      })
      await runSeed(options)
      for (const call of calls) {
        if (call.endpoint === 'user') continue
        expect(call.endpoint.startsWith('repos/' + P)).toBe(true)
      }
    }
    expect(() => assertApiTarget(['repos/example-owner/other/git/trees', '-X', 'POST'])).toThrow()
  })
})

interface FakeRepo {
  defaultBranch: string
  head: string
  issues: { number: number; state: string; user: { login: string }; pull_request?: unknown }[]
  pulls: { number: number; state: string; user: { login: string }; head: { ref: string } }[]
  branches: { name: string; protected?: boolean }[]
}

function cleanupRunner(repos: Record<string, FakeRepo>, calls: Call[]): Runner {
  return makeRunner(call => {
    const { endpoint, method } = call
    const match = /^repos\/([^/]+\/[^/?]+)(\/.*)?$/.exec(endpoint)
    if (!match) throw new Error('unexpected endpoint: ' + endpoint)
    const repo = repos[match[1] ?? '']
    if (!repo) throw new Error('unexpected repo: ' + endpoint)
    const rest = match[2] ?? ''
    if (rest === '') return result({ default_branch: repo.defaultBranch })
    if (rest === '/git/ref/heads/' + repo.defaultBranch) return result({ object: { sha: repo.head } })
    if (rest.startsWith('/issues?state=open')) return result([repo.issues.filter(issue => issue.state === 'open')])
    if (rest.startsWith('/pulls?state=open')) return result([repo.pulls.filter(pull => pull.state === 'open')])
    if (rest.startsWith('/branches?')) return result([repo.branches])
    const pull = /^\/pulls\/(\d+)$/.exec(rest)
    if (pull && method === 'PATCH') {
      const item = repo.pulls.find(p => p.number === Number(pull[1]))
      if (item) item.state = 'closed'
      return result({})
    }
    const issue = /^\/issues\/(\d+)$/.exec(rest)
    if (issue && method === 'PATCH') {
      const item = repo.issues.find(i => i.number === Number(issue[1]))
      if (item) item.state = 'closed'
      return result({})
    }
    if (rest.startsWith('/git/refs/heads/') && method === 'DELETE') {
      const name = rest.slice('/git/refs/heads/'.length)
      repo.branches = repo.branches.filter(branch => branch.name !== name)
      return result({})
    }
    throw new Error('unexpected call: ' + method + ' ' + endpoint + ' ' + calls.length)
  }, calls)
}

function cleanupFixture(): Record<string, FakeRepo> {
  return {
    'example/main': {
      defaultBranch: 'main',
      head: 'main-head',
      issues: [],
      pulls: [{ number: 9, state: 'open', user: { login: 'example-agent' }, head: { ref: 'agent/x' } }],
      branches: [{ name: 'main' }, { name: 'agent/x' }],
    },
    'example/playground': {
      defaultBranch: 'main',
      head: 'playground-head',
      issues: [{ number: 1, state: 'open', user: { login: 'example-owner' } }],
      pulls: [{ number: 2, state: 'open', user: { login: 'example-agent' }, head: { ref: 'agent/abc' } }],
      branches: [{ name: 'main' }, { name: 'agent/abc' }],
    },
  }
}

describe('live cleanup', () => {
  it('cleanup dry-run changes nothing', async () => {
    const calls: Call[] = []
    const lines: string[] = []
    const code = await runCleanup({
      token: 'token-under-test',
      apply: false,
      run: cleanupRunner(cleanupFixture(), calls),
      out: line => lines.push(line),
    })
    expect(code).toBe(0)
    expect(calls.filter(isWrite)).toHaveLength(0)
    expect(lines).toContain('example/playground issues=1 pulls=1 branches=1')
    expect(lines.some(line => line.startsWith('example/main issues=') && line.endsWith('report-only'))).toBe(true)
    expect(lines.filter(line => / issues=/.test(line))).toHaveLength(2)
  })

  it('cleanup apply touches only playground targets', async () => {
    const calls: Call[] = []
    const lines: string[] = []
    const code = await runCleanup({
      token: 'token-under-test',
      apply: true,
      run: cleanupRunner(cleanupFixture(), calls),
      out: line => lines.push(line),
    })
    expect(code).toBe(0)

    const writes = calls.filter(isWrite)
    const playground = 'repos/example/playground'
    expect(writes.map(call => call.method + ' ' + call.endpoint)).toEqual([
      'PATCH ' + playground + '/pulls/2',
      'DELETE ' + playground + '/git/refs/heads/agent/abc',
      'PATCH ' + playground + '/issues/1',
    ])
    expect(
      writes.filter(call => call.endpoint.startsWith('repos/example/main/') || call.endpoint === 'repos/example/main'),
    ).toHaveLength(0)
    expect(writes.some(call => call.endpoint.endsWith('/git/refs/heads/main'))).toBe(false)
  })
})

describe('live seed reset', () => {
  const full = loadSeed(true).map(file => ({ path: file.path, sha: blobSha(file.content) }))
  const target = loadSeed(true).find(file => file.path !== SEED_VERSION_PATH && file.path !== WORKFLOW_PATH)!.path
  const remoteWithDrift = (): { path: string; type: string; sha: string }[] =>
    seedRemote([
      ...full.map(file => (file.path === target ? { ...file, sha: 'merged' } : file)),
      { path: 'api/test/added.test.ts', sha: 'x' },
    ])
  const history = [
    { sha: 'h1', commit: { message: 'fix: correct paging (#7)' } },
    { sha: 's0', commit: { message: SEED_MESSAGES.workflowUpdate } },
  ]
  const harnessPull = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    number: 7,
    merged_at: '2026-01-01T00:00:00Z',
    merge_commit_sha: 'h1',
    head: { ref: 'agent/fix-paging' },
    user: { login: 'example-agent' },
    merged_by: { login: 'example-owner' },
    ...over,
  })

  it('harness merges since the seed are reset in one plain commit', async () => {
    const { options, calls, lines } = seedOptions({
      localScopes: ['repo', 'workflow'],
      remote: remoteWithDrift(),
      withoutCi: true,
      history,
      commitPulls: { h1: [{ number: 7, merge_commit_sha: 'h1' }] },
      pulls: { '7': harnessPull() },
    })
    const code = await runSeed(options)
    expect(code).toBe(0)
    expect(lines).toContain('STATUS: RESET commits=1 head=c1')

    const writes = calls.filter(isWrite)
    expect(writes.map(call => call.method + ' ' + call.endpoint)).toEqual([
      'POST repos/' + P + '/git/blobs',
      'POST repos/' + P + '/git/trees',
      'POST repos/' + P + '/git/commits',
      'PATCH repos/' + P + '/git/refs/heads/main',
    ])
    expect(writes.some(call => call.local)).toBe(false)
    expect(writes.some(call => call.input?.includes('"force":true'))).toBe(false)
    expect(JSON.parse(writes[3]?.input ?? '{}')).toEqual({ sha: 'c1', force: false })

    const commit = JSON.parse(writes[2]?.input ?? '{}') as { message: string }
    expect(commit.message).toBe('chore: reset the playground to the test seed')
    expect(commitProblems(commit.message)).toEqual([])

    const tree = JSON.parse(writes[1]?.input ?? '{}') as { tree: { path: string; sha: string | null }[] }
    expect(tree.tree).toContainEqual({ path: 'api/test/added.test.ts', mode: '100644', type: 'blob', sha: null })
    expect(tree.tree.some(entry => entry.path.startsWith('.github/workflows/'))).toBe(false)

    const after = new Map(full.map(file => [file.path, file.sha] as const))
    const hashedExpected = loadSeed(true).map(file => ({ path: file.path, content: blobSha(file.content) }))
    expect(seedPlan(hashedExpected, after)).toEqual({ kind: 'unchanged' })
    for (const call of calls) {
      if (call.endpoint === 'user') continue
      expect(() => assertApiTarget(call.args.slice(1))).not.toThrow()
      expect(call.endpoint.includes('example/main/')).toBe(false)
    }
  })

  it('a human commit since the seed is not reset', async () => {
    const { options, calls, lines } = seedOptions({
      localScopes: ['repo', 'workflow'],
      remote: remoteWithDrift(),
      withoutCi: true,
      history,
      commitPulls: { h1: [{ number: 7, merge_commit_sha: 'h1' }] },
      pulls: { '7': harnessPull({ merged_by: { login: 'someone' } }) },
    })
    const code = await runSeed(options)
    expect(code).toBe(1)
    expect(lines).toContain('STATUS: DIFF')
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('a seed that already matches reads no history and writes nothing', async () => {
    const { options, calls, lines } = seedOptions({
      localScopes: ['repo', 'workflow'],
      remote: seedRemote(full),
      withoutCi: true,
    })
    const code = await runSeed(options)
    expect(code).toBe(0)
    expect(lines).toContain('STATUS: UNCHANGED head=h1')
    expect(calls.some(call => call.endpoint.includes('/commits?sha='))).toBe(false)
    expect(calls.filter(isWrite)).toHaveLength(0)
  })
})

describe('live seed target gates', () => {
  const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url))
  const SCRIPTS = ['tests/live/seed-playground.ts', 'tests/live/cleanup-playground.ts']
  const TARGET_NAMES = [
    'ISSUECREW_LIVE_REPO',
    'ISSUECREW_LIVE_REPORT_REPO',
    'ISSUECREW_LIVE_OWNER_LOGIN',
    'ISSUECREW_LIVE_AGENT_LOGIN',
  ]

  function runScript(script: string, extra: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'live-fake-gh-'))
    const marker = join(dir, 'gh-called')
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho called >> "$GH_MARKER"\nexit 1\n', { mode: 0o755 })
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && !TARGET_NAMES.includes(key)) env[key] = value
    const result = spawnSync(process.execPath, [join(ROOT_DIR, script)], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...env,
        ISSUECREW_LIVE: '1',
        ISSUECREW_LIVE_OWNER_TOKEN: 'fake',
        NODE_NO_WARNINGS: '1',
        GH_MARKER: marker,
        PATH: dir + ':' + (process.env.PATH ?? ''),
        ...extra,
      },
    })
    return { result, marker, dir }
  }

  it('seed refuses without a live target', async () => {
    const { options, calls } = seedOptions({ localScopes: ['repo', 'workflow'], remote: [], withoutCi: true })
    clearLiveTarget()
    await expect(runSeed(options)).rejects.toThrow(/live target not configured/)
    expect(calls).toHaveLength(0)
  })

  it('cleanup refuses without a live target', async () => {
    const calls: Call[] = []
    clearLiveTarget()
    await expect(
      runCleanup({
        token: 'token-under-test',
        apply: false,
        run: cleanupRunner(cleanupFixture(), calls),
        out: () => {},
      }),
    ).rejects.toThrow(/live target not configured/)
    expect(calls).toHaveLength(0)
  })

  it('cleanup without a report repository touches one repository', async () => {
    stubLiveTarget({ ...EXAMPLE_TARGET_ENV, ISSUECREW_LIVE_REPORT_REPO: undefined })
    const calls: Call[] = []
    const lines: string[] = []
    await runCleanup({
      token: 'token-under-test',
      apply: false,
      run: cleanupRunner(cleanupFixture(), calls),
      out: line => lines.push(line),
    })
    expect(lines.filter(line => / issues=/.test(line))).toHaveLength(1)
    expect(lines.some(line => line.endsWith('report-only'))).toBe(false)
    expect(calls.some(call => call.endpoint.startsWith('repos/example/main/'))).toBe(false)
  })

  it('archived repository blocks before any write', async () => {
    const { options, calls, lines } = seedOptions({
      archived: true,
      localScopes: ['repo', 'workflow'],
      remote: [],
      withoutCi: true,
    })
    const code = await runSeed(options)
    expect(code).toBe(3)
    expect(lines).toContain('STATUS: BLOCKED')
    expect(lines).toContain('missing: repo-archived')
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('owner token of another account blocks', async () => {
    const { options, calls, lines } = seedOptions({
      tokenLogin: 'someone',
      localScopes: ['repo', 'workflow'],
      remote: [],
      withoutCi: true,
    })
    const code = await runSeed(options)
    expect(code).toBe(3)
    expect(lines).toContain('missing: token-login')
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('scripts skip without a target', () => {
    for (const script of SCRIPTS) {
      const { result, marker, dir } = runScript(script, {})
      try {
        expect(result.status, script).toBe(0)
        expect(result.stderr.trim(), script).toBe('skipped: ISSUECREW_LIVE_REPO is not set')
        expect(existsSync(marker), script).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it('scripts fail fast on a bad target', () => {
    for (const script of SCRIPTS) {
      const { result, marker, dir } = runScript(script, { ISSUECREW_LIVE_REPO: 'bad' })
      try {
        expect(result.status, script).toBe(1)
        expect(result.stderr, script).toContain('ISSUECREW_LIVE_REPO must be owner/name')
        expect(existsSync(marker), script).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 60_000)
})
