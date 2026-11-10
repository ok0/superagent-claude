import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { ALLOWED_REPOS, assertAllowedRepo, assertApiTarget } from './live/guard.ts'
import { downloadTree, ghJson, ghStatus, tokenScopes, type RunResult, type Runner } from './live/gh.ts'
import {
  AGENT_BRANCH,
  WORKFLOW_PATH,
  blobSha,
  changeVerdict,
  ciVerdict,
  cleanupTargets,
  closesIssue,
  commitProblems,
  contentProblems,
  preflight,
  runNodeTests,
  runTag,
  seedPlan,
  seedWorkflowProblems,
} from './live/rules.ts'

const FIXTURES = fileURLToPath(new URL('./live/fixtures', import.meta.url))
const SEED = join(FIXTURES, 'playground-seed')
const WORKFLOW_FIXTURE = join(FIXTURES, 'playground-ci.yml')

const ok = (stdout = '', stderr = ''): RunResult => ({ code: 0, stdout: Buffer.from(stdout), stderr })
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: Buffer.alloc(0), stderr })

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'live-rules-'))
}

describe('guard', () => {
  it('allows the three repositories in any case', () => {
    expect(assertAllowedRepo('OK0/Superagent-Claude-Playground')).toBe('OK0/Superagent-Claude-Playground')
    for (const repo of ALLOWED_REPOS) expect(() => assertAllowedRepo(repo)).not.toThrow()
  })

  it('rejects anything else', () => {
    const bad: unknown[] = ['ok0/superagent-claude-x', 'ok0/superagent-claude-playground-readonly2', 'other/superagent-claude', '', ' ok0/superagent-claude', 'ok0/superagent-claude/extra', 'ok0', undefined, 42]
    for (const repo of bad) expect(() => assertAllowedRepo(repo)).toThrow(/repository not allowed/)
  })

  it('assertApiTarget accepts allowed targets', () => {
    expect(() => assertApiTarget(['repos/ok0/superagent-claude-playground/issues', '-X', 'POST'])).not.toThrow()
    expect(() => assertApiTarget(['/repos/ok0/superagent-claude-playground-readonly'])).not.toThrow()
    expect(() => assertApiTarget(['user', '-i'])).not.toThrow()
    expect(() => assertApiTarget(['graphql', '-f', 'query=query { repository(owner: "ok0", name: "superagent-claude-playground") { id } }'])).not.toThrow()
  })

  it('assertApiTarget rejects everything else', () => {
    const bad: string[][] = [
      ['repos/other/x/issues'],
      ['repos/ok0/superagent-claude-x'],
      ['repos/ok0'],
      [],
      ['search/issues?q=x'],
      ['user', '-X', 'PATCH'],
      ['user', '-f', 'name=x'],
      ['graphql', '-f', 'query=mutation { x }'],
      ['graphql', '-f', 'query=query { repository(owner: "other", name: "x") { id } }'],
      ['graphql', '-f', 'query=query { viewer { login } }'],
      ['repos/ok0/superagent-claude-playground', '--hostname', 'example.com'],
    ]
    for (const args of bad) expect(() => assertApiTarget(args)).toThrow()
  })
})

describe('gh helpers', () => {
  it('refuses before spawning', async () => {
    const run = vi.fn<Runner>(async () => ok())
    await expect(ghJson('t', ['repos/other/x'], { run })).rejects.toThrow()
    await expect(ghStatus('t', 'repos/other/x', { run })).rejects.toThrow()
    const dir = scratch()
    try {
      await expect(downloadTree('t', 'other/x', 'abc', dir, { run })).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(run).toHaveBeenCalledTimes(0)
  })

  it('passes a minimal env', async () => {
    const run = vi.fn<Runner>(async () => ok('{"a":1}'))
    const result = await ghJson<{ a: number }>('t', ['user'], { run })
    expect(result).toEqual({ a: 1 })
    const [args, env] = run.mock.calls[0] ?? []
    expect(args?.[0]).toBe('api')
    expect(Object.keys(env ?? {}).sort()).toEqual(['GH_PROMPT_DISABLED', 'GH_TOKEN', 'HOME', 'PATH'])
    expect(env?.GH_TOKEN).toBe('t')
  })

  it('paginate flattens slurped pages', async () => {
    const run = vi.fn<Runner>(async () => ok('[[1,2],[3]]'))
    const result = await ghJson<number[]>('t', ['repos/ok0/superagent-claude-playground/issues'], { paginate: true, run })
    expect(result).toEqual([1, 2, 3])
    const args = run.mock.calls[0]?.[0] ?? []
    expect(args).toContain('--paginate')
    expect(args).toContain('--slurp')
  })

  it('errors carry only the endpoint', async () => {
    const run = vi.fn<Runner>(async () => fail('HTTP 404 secret-value'))
    await expect(ghJson('t', ['repos/ok0/superagent-claude-playground/issues'], { run })).rejects.toThrow(
      new Error('gh api failed: repos/ok0/superagent-claude-playground/issues'),
    )
  })

  it('ghStatus reads the HTTP code', async () => {
    const run = vi.fn<Runner>(async () => fail('gh: Not Found (HTTP 404)'))
    expect(await ghStatus('t', 'repos/ok0/superagent-claude-playground', { run })).toBe(404)
  })

  it('tokenScopes parses the header', async () => {
    const run = vi.fn<Runner>(async () => ok('HTTP/2.0 200 OK\r\nX-Oauth-Scopes: notifications, repo\r\n\r\n{}'))
    expect(await tokenScopes('t', { run })).toEqual(['notifications', 'repo'])
    const bare = vi.fn<Runner>(async () => ok('HTTP/2.0 200 OK\r\n\r\n{}'))
    expect(await tokenScopes('t', { run: bare })).toEqual([])
  })
})

describe('preflight', () => {
  it('blocks without the workflow scope', () => {
    const result = preflight({ scopes: ['notifications', 'repo'], actionsEnabled: true })
    expect(result.status).toBe('BLOCKED')
    if (result.status !== 'BLOCKED') return
    expect(result.missing).toEqual(['workflow-scope'])
    expect(result.actions[0]).toContain('workflow')
  })

  it('blocks with Actions disabled', () => {
    const result = preflight({ scopes: ['repo', 'workflow'], actionsEnabled: false })
    expect(result.status).toBe('BLOCKED')
    if (result.status !== 'BLOCKED') return
    expect(result.missing).toEqual(['actions-disabled'])
  })

  it('lists both', () => {
    const result = preflight({ scopes: ['repo'], actionsEnabled: false })
    expect(result.status).toBe('BLOCKED')
    if (result.status !== 'BLOCKED') return
    expect(result.missing).toHaveLength(2)
    expect(result.actions).toHaveLength(2)
  })

  it('is ready when both hold', () => {
    expect(preflight({ scopes: ['repo', 'Workflow'], actionsEnabled: true })).toEqual({ status: 'ready' })
  })
})

describe('content rules', () => {
  it('flags milestone ids and the word', () => {
    for (const text of ['fixed in M29', 'M3', 'next Milestone', 'MILESTONE']) expect(contentProblems('x', text).length).toBeGreaterThan(0)
  })

  it('allows ordinary text', () => {
    for (const text of ['run-1a2b3c4d', 'mM1', 'HTML5', 'M.2', 'Fix truncate for exact lengths']) expect(contentProblems('x', text)).toEqual([])
  })

  it('commitProblems', () => {
    expect(commitProblems('fix: keep text that fits in truncate')).toEqual([])
    expect(commitProblems('Fix truncate').length).toBeGreaterThan(0)
    expect(commitProblems('fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>').length).toBeGreaterThan(0)
    expect(commitProblems('fix: done in M29').length).toBeGreaterThan(0)
  })

  it('runTag', () => {
    expect(runTag(Buffer.from([1, 2, 3, 4]))).toBe('run-01020304')
    const tag = runTag()
    expect(tag).toMatch(/^run-[0-9a-f]{8}$/)
    expect(contentProblems('tag', tag)).toEqual([])
  })

  it('closesIssue', () => {
    expect(closesIssue('Fixes #12', 'ok0/superagent-claude-playground', 12)).toBe(true)
    expect(closesIssue('Fixes #12', 'ok0/superagent-claude-playground', 123)).toBe(false)
    expect(closesIssue('Closes https://github.com/ok0/superagent-claude-playground/issues/7', 'ok0/superagent-claude-playground', 7)).toBe(true)
  })
})

describe('change verdict', () => {
  it('classifies changes', () => {
    expect(changeVerdict(['src/text.js', 'test/text.test.js']).pass).toBe(true)
    expect(changeVerdict(['README.md'])).toMatchObject({ pass: false, reason: 'docs-only' })
    expect(changeVerdict(['docs/usage.md', 'CHANGELOG.md'])).toMatchObject({ pass: false, reason: 'docs-only' })
    expect(changeVerdict(['src/text.js'])).toMatchObject({ pass: false, reason: 'no-test' })
    expect(changeVerdict(['test/text.test.js'])).toMatchObject({ pass: false, reason: 'no-source' })
    expect(changeVerdict([])).toMatchObject({ pass: false, reason: 'empty' })
  })
})

describe('seed', () => {
  it('blobSha matches git', () => {
    expect(blobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('seedPlan', () => {
    const expected = [
      { path: 'a.js', content: 'A' },
      { path: 'b.js', content: 'B' },
      { path: WORKFLOW_PATH, content: 'W' },
    ]
    expect(seedPlan(expected, new Map())).toEqual({ kind: 'create', paths: ['a.js', 'b.js', WORKFLOW_PATH] })
    expect(seedPlan(expected, new Map([['a.js', 'A'], ['b.js', 'B'], [WORKFLOW_PATH, 'W'], ['README.md', 'x']]))).toEqual({ kind: 'unchanged' })
    const differs = seedPlan(expected, new Map([['a.js', 'changed'], ['b.js', 'B'], [WORKFLOW_PATH, 'W']]))
    expect(differs.kind).toBe('diff')
    if (differs.kind === 'diff') expect(differs.problems).toContain('a.js: content differs')
    expect(seedPlan(expected, new Map([['a.js', 'A'], ['b.js', 'B']]))).toEqual({ kind: 'create', paths: [WORKFLOW_PATH] })
    expect(seedPlan(expected, new Map([['a.js', 'A']])).kind).toBe('diff')
  })

  it('seedWorkflowProblems', () => {
    const fixture = readFileSync(WORKFLOW_FIXTURE, 'utf8')
    expect(seedWorkflowProblems(fixture)).toEqual([])
    const mutations = [
      fixture.replace('      - run: npm test', '      - run: npm test\n      - run: echo ${{ secrets.X }}'),
      fixture.replace('actions/checkout@v4', 'someone/checkout@v1'),
      fixture.replace('contents: read', 'contents: write'),
      fixture.replace('  pull_request:\n', ''),
      fixture.replace('on:\n', 'on:\n  pull_request_target:\n'),
    ]
    for (const mutated of mutations) expect(seedWorkflowProblems(mutated).length).toBeGreaterThan(0)
  })
})

describe('fixtures', () => {
  const seedFiles = (): string[] => readdirSync(SEED, { recursive: true }).map(String).filter(entry => statSync(join(SEED, entry)).isFile())

  it('seed files are clean', () => {
    for (const file of [...seedFiles().map(entry => join(SEED, entry)), WORKFLOW_FIXTURE]) {
      expect(contentProblems(file, readFileSync(file, 'utf8'))).toEqual([])
    }
  })

  it('the package needs no install', () => {
    const pkg = JSON.parse(readFileSync(join(SEED, 'package.json'), 'utf8')) as Record<string, unknown>
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) expect(pkg[key]).toBeUndefined()
    expect((pkg.scripts as Record<string, string>).test).toBe('node --test')
    expect(pkg.type).toBe('module')
  })

  it('seed tests pass', async () => {
    const dir = scratch()
    try {
      cpSync(SEED, dir, { recursive: true })
      expect((await runNodeTests(dir)).code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the planted bug is reproducible', async () => {
    const dir = scratch()
    try {
      cpSync(SEED, dir, { recursive: true })
      writeFileSync(
        join(dir, 'test', 'fits.test.js'),
        "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { truncate } from '../src/text.js'\n\ntest('text that fits stays', () => assert.equal(truncate('hello', 5), 'hello'))\n",
      )
      expect((await runNodeTests(dir)).code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('titleCase is not there yet', async () => {
    const mod = (await import(pathToFileURL(join(SEED, 'src', 'text.js')).href)) as Record<string, unknown>
    expect(Object.keys(mod)).not.toContain('titleCase')
  })
})

describe('ci verdict', () => {
  it('reports the check state', () => {
    expect(ciVerdict([])).toBe('none')
    expect(ciVerdict([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'success' }])).toBe('success')
    expect(ciVerdict([{ status: 'in_progress', conclusion: null }])).toBe('pending')
    expect(ciVerdict([{ status: 'completed', conclusion: 'failure' }])).toBe('failure')
  })
})

describe('cleanup selection', () => {
  const issues = [
    { number: 1, state: 'open', user: { login: 'ok0' } },
    { number: 2, state: 'open', user: { login: 'stranger' } },
    { number: 3, state: 'open', user: { login: 'ok0' }, pull_request: {} },
    { number: 4, state: 'closed', user: { login: 'ok0' } },
  ]
  const pulls = [
    { number: 5, state: 'open', user: { login: 'ok0-worker' }, head: { ref: 'agent/abc' } },
    { number: 6, state: 'open', user: { login: 'stranger' }, head: { ref: 'agent/keep' } },
    { number: 7, state: 'open', user: { login: 'ok0' }, head: { ref: 'feature/x' } },
  ]
  const branches = [
    { name: 'main' },
    { name: 'agent/abc' },
    { name: 'agent/keep' },
    { name: 'agent/prot', protected: true },
    { name: 'feature/x' },
    { name: 'agent/old' },
  ]

  it('selects playground leftovers', () => {
    const targets = cleanupTargets({ repo: 'ok0/superagent-claude-playground', defaultBranch: 'main', issues, pulls, branches, authors: ['ok0', 'ok0-worker'], agent: 'ok0-worker' })
    expect(targets).toEqual({ repo: 'ok0/superagent-claude-playground', reportOnly: false, issues: [1], pulls: [5, 7], branches: ['agent/abc', 'agent/old'] })
  })

  it('reports only for the main repository', () => {
    const targets = cleanupTargets({ repo: 'ok0/superagent-claude', defaultBranch: 'main', issues, pulls, branches, authors: ['ok0', 'ok0-worker'], agent: 'ok0-worker' })
    expect(targets).toEqual({ repo: 'ok0/superagent-claude', reportOnly: true, issues: [], pulls: [5, 6], branches: ['agent/abc', 'agent/keep', 'agent/old'] })
  })

  it('rejects other repositories', () => {
    expect(() => cleanupTargets({ repo: 'evil/x', defaultBranch: 'main', issues, pulls, branches, authors: ['ok0'], agent: 'ok0-worker' })).toThrow()
  })

  it('agent branch pattern', () => {
    expect(AGENT_BRANCH.test('agent/abc')).toBe(true)
    expect(AGENT_BRANCH.test('agent/')).toBe(false)
  })
})
