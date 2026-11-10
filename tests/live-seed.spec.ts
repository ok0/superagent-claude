import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunResult, Runner } from './live/gh.ts'
import { runCleanup } from './live/cleanup-playground.ts'
import { PLAYGROUND, loadSeed, runSeed } from './live/seed-playground.ts'
import { WORKFLOW_PATH, blobSha, commitProblems } from './live/rules.ts'

interface Call { endpoint: string; method: string; input?: string; args: readonly string[] }

function result(body: unknown): RunResult {
  return { code: 0, stdout: Buffer.from(JSON.stringify(body)), stderr: '' }
}

function methodOf(args: readonly string[]): string {
  const index = args.indexOf('-X')
  return index >= 0 ? (args[index + 1] ?? 'GET') : 'GET'
}

function makeRunner(route: (call: Call) => RunResult, calls: Call[]): Runner {
  return async (args, _env, input) => {
    const call: Call = { endpoint: args[1] ?? '', method: methodOf(args), input, args }
    calls.push(call)
    return route(call)
  }
}

function isWrite(call: Call): boolean {
  return ['POST', 'PATCH', 'DELETE'].includes(call.method)
}

function seedRemote(files: { path: string; sha: string }[]) {
  return files.map(file => ({ path: file.path, type: 'blob', sha: file.sha }))
}

function seedRunner(opts: { scopes: string[]; remote: { path: string; type: string; sha: string }[]; actionsEnabled?: boolean }) {
  const calls: Call[] = []
  let blobCount = 0
  const P = PLAYGROUND
  const run = makeRunner(call => {
    const { endpoint, method } = call
    if (endpoint === 'user') {
      return { code: 0, stdout: Buffer.from('HTTP/2 200\r\nx-oauth-scopes: ' + opts.scopes.join(', ') + '\r\n\r\n{}'), stderr: '' }
    }
    if (endpoint === 'repos/' + P + '/actions/permissions') return result({ enabled: opts.actionsEnabled ?? true })
    if (endpoint.startsWith('repos/' + P + '/actions/runs')) return result({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] })
    if (endpoint === 'repos/' + P) return result({ default_branch: 'main' })
    if (endpoint === 'repos/' + P + '/git/ref/heads/main') return result({ object: { sha: 'h1' } })
    if (endpoint === 'repos/' + P + '/git/commits/h1') return result({ tree: { sha: 't1' } })
    if (endpoint === 'repos/' + P + '/git/trees/t1?recursive=1') return result({ truncated: false, tree: opts.remote })
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

function seedOptions(overrides: { scopes: string[]; remote: { path: string; type: string; sha: string }[]; withoutCi: boolean; actionsEnabled?: boolean }) {
  const { run, calls } = seedRunner(overrides)
  const lines: string[] = []
  return {
    calls,
    lines,
    options: {
      token: 'token-under-test',
      withoutCi: overrides.withoutCi,
      run,
      out: (line: string) => lines.push(line),
      recordDir: mkdtempSync(join(tmpdir(), 'live-seed-')),
      pollMs: 1,
      ciTimeoutMs: 1000,
    },
  }
}

describe('live seed', () => {
  it('BLOCKED makes no write call', async () => {
    const { options, calls, lines } = seedOptions({ scopes: ['notifications', 'repo'], remote: [], withoutCi: false })
    const code = await runSeed(options)
    expect(code).toBe(3)
    expect(lines).toContain('STATUS: BLOCKED')
    expect(lines.some(line => line.includes('workflow'))).toBe(true)
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('unchanged seed makes no commit', async () => {
    const remote = seedRemote([
      ...loadSeed(true).map(file => ({ path: file.path, sha: blobSha(file.content) })),
      { path: 'README.md', sha: 'readme-sha' },
    ])
    const { options, calls, lines } = seedOptions({ scopes: ['repo', 'workflow'], remote, withoutCi: false })
    const code = await runSeed(options)
    expect(code).toBe(0)
    expect(lines.some(line => line.startsWith('STATUS: UNCHANGED'))).toBe(true)
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('different content is reported, not overwritten', async () => {
    const remote = seedRemote([{ path: 'src/text.js', sha: 'not-the-expected-sha' }])
    const { options, calls, lines } = seedOptions({ scopes: ['repo', 'workflow'], remote, withoutCi: false })
    const code = await runSeed(options)
    expect(code).toBe(1)
    expect(lines).toContain('STATUS: DIFF')
    expect(calls.filter(isWrite)).toHaveLength(0)
  })

  it('without-ci seeds the package in one normal commit', async () => {
    const remote = seedRemote([{ path: 'README.md', sha: 'readme-sha' }])
    const { options, calls, lines } = seedOptions({ scopes: ['repo'], remote, withoutCi: true })
    const code = await runSeed(options)
    expect(code).toBe(0)
    expect(lines).toContain('CI: BLOCKED(no-workflow-scope)')
    expect(lines.some(line => line.startsWith('STATUS: SEEDED'))).toBe(true)

    const writes = calls.filter(isWrite)
    expect(writes.map(call => call.method + ' ' + call.endpoint)).toEqual([
      'POST repos/' + PLAYGROUND + '/git/blobs',
      'POST repos/' + PLAYGROUND + '/git/blobs',
      'POST repos/' + PLAYGROUND + '/git/blobs',
      'POST repos/' + PLAYGROUND + '/git/trees',
      'POST repos/' + PLAYGROUND + '/git/commits',
      'PATCH repos/' + PLAYGROUND + '/git/refs/heads/main',
    ])

    const treeCall = writes[3]
    const tree = JSON.parse(treeCall?.input ?? '{}') as { tree: { path: string }[] }
    expect(tree.tree.map(entry => entry.path)).toEqual(loadSeed(false).map(file => file.path))
    expect(tree.tree.map(entry => entry.path)).not.toContain(WORKFLOW_PATH)

    const commitCall = writes[4]
    const commit = JSON.parse(commitCall?.input ?? '{}') as { message: string; parents: string[] }
    expect(commit.parents).toEqual(['h1'])
    expect(commitProblems(commit.message)).toEqual([])

    const refCall = writes[5]
    expect(JSON.parse(refCall?.input ?? '{}')).toEqual({ sha: 'c1', force: false })
  })

  it('adds only the workflow once the scope exists', async () => {
    const remote = seedRemote([
      ...loadSeed(false).map(file => ({ path: file.path, sha: blobSha(file.content) })),
      { path: 'README.md', sha: 'readme-sha' },
    ])
    const { options, calls } = seedOptions({ scopes: ['repo', 'workflow'], remote, withoutCi: false })
    const code = await runSeed(options)
    expect(code).toBe(0)

    const writes = calls.filter(isWrite)
    const treeCall = writes.find(call => call.method === 'POST' && call.endpoint.endsWith('/git/trees'))
    const tree = JSON.parse(treeCall?.input ?? '{}') as { tree: { path: string }[] }
    expect(tree.tree.map(entry => entry.path)).toEqual([WORKFLOW_PATH])

    const commitCall = writes.find(call => call.method === 'POST' && call.endpoint.endsWith('/git/commits'))
    const commit = JSON.parse(commitCall?.input ?? '{}') as { message: string }
    expect(commit.message).toBe('ci: add test workflow')
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
    'ok0/superagent-claude-playground-readonly': {
      defaultBranch: 'main',
      head: 'readonly-head',
      issues: [],
      pulls: [],
      branches: [{ name: 'main' }],
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
