import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunResult, Runner } from './live/gh.ts'
import { runCleanup } from './live/cleanup-playground.ts'
import { PLAYGROUND, loadSeed, runSeed } from './live/seed-playground.ts'
import { WORKFLOW_PATH, blobSha, commitProblems } from './live/rules.ts'
import { assertApiTarget } from './live/guard.ts'

interface Call { endpoint: string; method: string; input?: string; args: readonly string[]; local: boolean }

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
    const call: Call = { endpoint: args[1] ?? '', method: methodOf(args), input, args, local: env.GH_TOKEN === undefined }
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
}

function seedRunner(opts: SeedRoute) {
  const calls: Call[] = []
  let blobCount = 0
  let putCount = 0
  const P = PLAYGROUND
  const repoStatus = opts.repoStatus ?? 200
  const localLogin = opts.localLogin === undefined ? 'ok0' : opts.localLogin
  const run = makeRunner(call => {
    const { endpoint, method } = call
    if (endpoint === 'user') {
      if (!call.local) throw new Error('unexpected call: ' + method + ' ' + endpoint)
      if (localLogin === null) return failure('gh: not logged in')
      return { code: 0, stdout: Buffer.from('HTTP/2 200\r\nx-oauth-scopes: ' + opts.localScopes.join(', ') + '\r\n\r\n{"login":"' + localLogin + '"}'), stderr: '' }
    }
    if (endpoint === 'repos/' + P && call.args.includes('--silent')) return repoStatus === 200 ? result({}) : failure('gh: Not Found (HTTP ' + repoStatus + ')')
    if (endpoint === 'repos/' + P + '/actions/permissions') return result({ enabled: opts.actionsEnabled ?? true })
    if (endpoint.startsWith('repos/' + P + '/actions/runs')) return result({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] })
    if (endpoint === 'repos/' + P) return result({ default_branch: 'main' })
    if (endpoint === 'repos/' + P + '/git/ref/heads/main') {
      if (opts.remote === 'empty') return failure('gh: Git Repository is empty. (HTTP 409)')
      return result({ object: { sha: 'h1' } })
    }
    if (endpoint === 'repos/' + P + '/git/commits/h1') return result({ tree: { sha: 't1' } })
    if (endpoint === 'repos/' + P + '/git/trees/t1?recursive=1') return result({ truncated: false, tree: opts.remote === 'empty' ? [] : opts.remote })
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
    throw new Error('unexpected call: ' + method + ' ' + endpoint)
  }, calls)
  return { run, calls }
}

const OLD_SEED = [{ path: 'package.json', sha: 'old-pkg' }, { path: 'src/text.js', sha: 'old-src' }, { path: 'test/text.test.js', sha: 'old-test' }]
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

const P = PLAYGROUND

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
    const { options, calls, lines } = seedOptions({ repoStatus: 404, localScopes: ['repo', 'workflow'], remote: [], withoutCi: true })
    const code = await runSeed(options)
    expect(code).toBe(3)
    expect(lines).toContain('missing: repo-access')
    expect(calls.filter(isWrite)).toHaveLength(0)
    expect(calls.some(call => call.endpoint === 'repos/' + P + '/actions/permissions')).toBe(false)
    expect(calls.some(call => call.endpoint.includes('/git/ref'))).toBe(false)
  })

  it('BLOCKED when local gh is another account', async () => {
    const { options, calls, lines } = seedOptions({ localLogin: 'someone', localScopes: ['repo', 'workflow'], remote: [], withoutCi: false })
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
    const { options, calls, lines } = seedOptions({ localScopes: ['repo', 'workflow'], remote: 'empty', withoutCi: true })
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
    expect(writes.map(call => call.method + ' ' + call.endpoint)).toEqual(['PUT repos/' + P + '/contents/' + WORKFLOW_PATH])
    expect(writes[0]?.local).toBe(true)
    const put = JSON.parse(writes[0]?.input ?? '{}') as { message: string; branch: string; content: string }
    expect(put).toMatchObject({ message: 'ci: add test workflow', branch: 'main' })
    expect(Buffer.from(put.content, 'base64').toString('utf8')).toBe(loadSeed(true).find(file => file.path === WORKFLOW_PATH)?.content)
    expect(calls.some(call => call.endpoint.startsWith('repos/' + P + '/actions/runs?head_sha=k1') && call.local === false)).toBe(true)
    expect(lines.some(line => line.startsWith('CI: success'))).toBe(true)
  })

  it('full flow on an empty repository adds the package with the owner token and the workflow with local gh', async () => {
    const { options, calls, lines } = seedOptions({ localScopes: ['repo', 'workflow'], remote: 'empty', withoutCi: false })
    const code = await runSeed(options)
    expect(code).toBe(0)

    const writes = calls.filter(isWrite)
    expect(writes[0]).toMatchObject({ method: 'PUT', endpoint: 'repos/' + P + '/contents/' + loadSeed(false)[0]!.path, local: false })
    expect(writes[writes.length - 1]).toMatchObject({ method: 'PUT', endpoint: 'repos/' + P + '/contents/' + WORKFLOW_PATH, local: true })
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
    const { options, calls, lines } = seedOptions({ localScopes: ['repo', 'workflow'], remote, withoutCi: false, upgrade: true })
    const code = await runSeed(options)
    expect(code).toBe(0)
    expect(lines).toContain('STATUS: UNCHANGED head=h1')
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('replaces an older seed in one commit and leaves the workflow alone', async () => {
    const remote = upgradeRemote([...OLD_SEED, { path: WORKFLOW_PATH, sha: ciSha() }])
    const { options, calls, lines } = seedOptions({ localScopes: ['repo', 'workflow'], remote, withoutCi: false, upgrade: true })
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
    const tree = JSON.parse(treeCall?.input ?? '{}') as { base_tree: string; tree: { path: string; sha: string | null }[] }
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

    expect(lines.filter(line => line.startsWith('removed: '))).toEqual(['removed: src/text.js', 'removed: test/text.test.js'])
  })

  it('a changed workflow goes through local gh as a separate commit', async () => {
    const remote = upgradeRemote([...OLD_SEED, { path: WORKFLOW_PATH, sha: 'old-ci' }])
    const { options, calls, lines } = seedOptions({ localScopes: ['repo', 'workflow'], remote, withoutCi: false, upgrade: true })
    const code = await runSeed(options)
    expect(code).toBe(0)

    const writes = calls.filter(isWrite)
    const last = writes[writes.length - 1]
    expect(last).toMatchObject({ method: 'PUT', endpoint: 'repos/' + P + '/contents/' + WORKFLOW_PATH, local: true })
    expect(JSON.parse(last?.input ?? '{}')).toMatchObject({ message: 'ci: install, typecheck and test every workspace', branch: 'main', sha: 'old-ci' })
    const put = JSON.parse(last?.input ?? '{}') as { content: string }
    expect(Buffer.from(put.content, 'base64').toString('utf8')).toBe(loadSeed(true).find(file => file.path === WORKFLOW_PATH)?.content)
    expect(lines.filter(line => line.startsWith('commit:'))).toHaveLength(2)
    expect(lines.some(line => line.startsWith('CI: success'))).toBe(true)
  })

  it('--without-ci leaves a changed workflow untouched', async () => {
    const remote = upgradeRemote([...OLD_SEED, { path: WORKFLOW_PATH, sha: 'old-ci' }])
    const { options, calls } = seedOptions({ localScopes: ['repo', 'workflow'], remote, withoutCi: true, upgrade: true })
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
      const { options, calls } = seedOptions({ localScopes: ['repo', 'workflow'], remote, withoutCi: false, upgrade: true })
      await runSeed(options)
      for (const call of calls) {
        if (call.endpoint === 'user') continue
        expect(call.endpoint.startsWith('repos/' + P)).toBe(true)
      }
    }
    expect(() => assertApiTarget(['repos/ok0/other/git/trees', '-X', 'POST'])).toThrow()
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
    'ok0/superagent-claude': {
      defaultBranch: 'main',
      head: 'main-head',
      issues: [],
      pulls: [{ number: 9, state: 'open', user: { login: 'ok0-worker' }, head: { ref: 'agent/x' } }],
      branches: [{ name: 'main' }, { name: 'agent/x' }],
    },
    'ok0/superagent-claude-playground': {
      defaultBranch: 'main',
      head: 'playground-head',
      issues: [{ number: 1, state: 'open', user: { login: 'ok0' } }],
      pulls: [{ number: 2, state: 'open', user: { login: 'ok0-worker' }, head: { ref: 'agent/abc' } }],
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
    expect(lines).toContain('ok0/superagent-claude-playground issues=1 pulls=1 branches=1')
    expect(lines.some(line => line.startsWith('ok0/superagent-claude issues=') && line.endsWith('report-only'))).toBe(true)
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
    const playground = 'repos/ok0/superagent-claude-playground'
    expect(writes.map(call => call.method + ' ' + call.endpoint)).toEqual([
      'PATCH ' + playground + '/pulls/2',
      'DELETE ' + playground + '/git/refs/heads/agent/abc',
      'PATCH ' + playground + '/issues/1',
    ])
    expect(writes.filter(call => call.endpoint.startsWith('repos/ok0/superagent-claude/') || call.endpoint === 'repos/ok0/superagent-claude')).toHaveLength(0)
    expect(writes.some(call => call.endpoint.endsWith('/git/refs/heads/main'))).toBe(false)
  })
})
