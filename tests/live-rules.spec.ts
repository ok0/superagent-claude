import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { loadConfig } from '../src/app/config.ts'
import { liveConfig } from './live/code-change-config.ts'
import { loadSeed } from './live/seed-playground.ts'
import { assertAllowedRepo, assertApiTarget, isAllowedRepo } from './live/guard.ts'
import { requireLiveTarget } from './live/target.ts'
import { EXAMPLE_TARGET_ENV, stubLiveTarget } from './fixtures/live-target.ts'
import {
  downloadTree,
  ghJson,
  ghLocalJson,
  ghLocalRaw,
  ghStatus,
  localIdentity,
  tokenScopes,
  type RunResult,
  type Runner,
} from './live/gh.ts'
import {
  AGENT_BRANCH,
  WORKFLOW_PATH,
  attributionProblems,
  readmeProblems,
  seedVersion,
  blobSha,
  changeVerdict,
  ciBlockedLabel,
  ciVerdict,
  cleanupTargets,
  closesIssue,
  commitProblems,
  contentProblems,
  harnessMergesOnly,
  preflight,
  runNodeTests,
  runTag,
  SEED_MESSAGES,
  seedPlan,
  seedWorkflowProblems,
  type HarnessPull,
  type HistoryCommit,
} from './live/rules.ts'

beforeEach(() => stubLiveTarget(EXAMPLE_TARGET_ENV))
afterEach(() => vi.unstubAllEnvs())

const LOGINS = { agentLogin: 'example-agent', ownerLogin: 'example-owner' }

const FIXTURES = fileURLToPath(new URL('./live/fixtures', import.meta.url))
const SEED = join(FIXTURES, 'playground-seed')
const WORKFLOW_FIXTURE = join(FIXTURES, 'playground-ci.yml')
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const LOCK_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']
const ALL_PAGES_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTaskService } from '../src/services/task-service.ts'
import { createIdGenerator } from '../src/store/ids.ts'
import { createMemoryStore } from '../src/store/memory-store.ts'

test('every task is listed across pages', () => {
  const service = createTaskService({ store: createMemoryStore(), nextId: createIdGenerator() })
  for (let i = 0; i < 5; i++) service.create({ title: 'task ' + i }, 'alice')
  let total = 0
  let next: number | null = 0
  while (next !== null) {
    const page = service.list({ start: next, limit: 2 })
    total += page.items.length
    next = page.next
  }
  assert.equal(total, 5)
})
`

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

const ok = (stdout = '', stderr = ''): RunResult => ({ code: 0, stdout: Buffer.from(stdout), stderr })
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: Buffer.alloc(0), stderr })

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'live-rules-'))
}

describe('guard', () => {
  it('allows exactly the two repositories in any case', () => {
    expect(assertAllowedRepo('EXAMPLE/Playground')).toBe('EXAMPLE/Playground')
    expect(assertAllowedRepo('example/main')).toBe('example/main')
    expect(isAllowedRepo('example/playground')).toBe(true)
    expect(isAllowedRepo('example/main')).toBe(true)
    expect(isAllowedRepo('example/other')).toBe(false)
  })

  it('rejects anything else', () => {
    const bad: unknown[] = [
      'example/main-x',
      'example/playground' + '-readonly',
      'example/playground' + '-readonly2',
      'example/main-archived',
      'example/playground-archived',
      'OK0/Superagent-Claude-Playground-Archived',
      'other/superagent-claude',
      '',
      ' example/main',
      'example/main/extra',
      'example-owner',
      undefined,
      42,
    ]
    for (const repo of bad) expect(() => assertAllowedRepo(repo)).toThrow(/repository not allowed/)
  })

  it('assertApiTarget accepts allowed targets', () => {
    expect(() => assertApiTarget(['repos/example/playground/issues', '-X', 'POST'])).not.toThrow()
    expect(() => assertApiTarget(['user', '-i'])).not.toThrow()
    expect(() =>
      assertApiTarget(['graphql', '-f', 'query=query { repository(owner: "example", name: "playground") { id } }']),
    ).not.toThrow()
  })

  it('assertApiTarget rejects everything else', () => {
    const bad: string[][] = [
      ['repos/other/x/issues'],
      ['repos/example/main-x'],
      ['repos/example-owner'],
      [],
      ['search/issues?q=x'],
      ['user', '-X', 'PATCH'],
      ['user', '-f', 'name=x'],
      ['graphql', '-f', 'query=mutation { x }'],
      ['graphql', '-f', 'query=query { repository(owner: "other", name: "x") { id } }'],
      ['graphql', '-f', 'query=query { viewer { login } }'],
      ['repos/example/playground', '--hostname', 'example.com'],
      ['/repos/example/playground' + '-readonly'],
      ['repos/example/playground-archived/issues'],
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
    const result = await ghJson<number[]>('t', ['repos/example/playground/issues'], { paginate: true, run })
    expect(result).toEqual([1, 2, 3])
    const args = run.mock.calls[0]?.[0] ?? []
    expect(args).toContain('--paginate')
    expect(args).toContain('--slurp')
  })

  it('errors carry only the endpoint', async () => {
    const run = vi.fn<Runner>(async () => fail('HTTP 404 secret-value'))
    await expect(ghJson('t', ['repos/example/playground/issues'], { run })).rejects.toThrow(
      new Error('gh api failed: repos/example/playground/issues'),
    )
  })

  it('ghStatus reads the HTTP code', async () => {
    const run = vi.fn<Runner>(async () => fail('gh: Not Found (HTTP 404)'))
    expect(await ghStatus('t', 'repos/example/playground', { run })).toBe(404)
  })

  it('tokenScopes parses the header', async () => {
    const run = vi.fn<Runner>(async () => ok('HTTP/2.0 200 OK\r\nX-Oauth-Scopes: notifications, repo\r\n\r\n{}'))
    expect(await tokenScopes('t', { run })).toEqual(['notifications', 'repo'])
    const bare = vi.fn<Runner>(async () => ok('HTTP/2.0 200 OK\r\n\r\n{}'))
    expect(await tokenScopes('t', { run: bare })).toEqual([])
  })

  it('ghLocalRaw refuses a disallowed repository before spawning', async () => {
    const run = vi.fn<Runner>(async () => ok())
    await expect(ghLocalRaw(['repos/example/main-archived'], { run })).rejects.toThrow(/repository not allowed/)
    expect(run).toHaveBeenCalledTimes(0)
  })

  it('local gh env carries no token', async () => {
    vi.stubEnv('GH_TOKEN', 'secret-gh-token')
    vi.stubEnv('GITHUB_TOKEN', 'secret-github-token')
    try {
      const run = vi.fn<Runner>(async () => ok())
      await ghLocalRaw(['user', '-i'], { run })
      const env = run.mock.calls[0]?.[1] ?? {}
      for (const key of Object.keys(env))
        expect(['PATH', 'HOME', 'GH_PROMPT_DISABLED', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']).toContain(key)
      expect(env.GH_PROMPT_DISABLED).toBe('1')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('localIdentity reads login and scopes', async () => {
    const run = vi.fn<Runner>(async () =>
      ok('HTTP/2.0 200 OK\r\nx-oauth-scopes: repo, workflow\r\n\r\n{"login":"example-owner"}'),
    )
    expect(await localIdentity({ run })).toEqual({ login: 'example-owner', scopes: ['repo', 'workflow'] })
    const broken = vi.fn<Runner>(async () => fail('HTTP 401'))
    expect(await localIdentity({ run: broken })).toEqual({ login: null, scopes: [] })
  })

  it('ghLocalJson reports the endpoint only', async () => {
    const run = vi.fn<Runner>(async () => fail('secret-text', 1))
    await expect(ghLocalJson(['repos/example/playground'], { run })).rejects.toThrow(
      new Error('gh api failed (local gh): repos/example/playground'),
    )
  })
})

describe('preflight', () => {
  const ready = () => ({
    target: requireLiveTarget(),
    repoStatus: 200,
    archived: false,
    tokenLogin: 'example-owner',
    localLogin: 'example-owner',
    localScopes: ['repo', 'workflow'],
    actionsEnabled: true,
  })

  it('is ready when every check holds', () => {
    expect(preflight({ ...ready(), localLogin: 'EXAMPLE-OWNER', localScopes: ['repo', 'Workflow'] })).toEqual({
      status: 'ready',
    })
  })

  it('blocks on repository access', () => {
    expect(preflight({ ...ready(), repoStatus: 404 })).toMatchObject({ status: 'BLOCKED', missing: ['repo-access'] })
  })

  it('blocks on another local gh account', () => {
    expect(preflight({ ...ready(), localLogin: 'someone' })).toMatchObject({
      status: 'BLOCKED',
      missing: ['local-gh-account'],
    })
    expect(preflight({ ...ready(), localLogin: null })).toMatchObject({
      status: 'BLOCKED',
      missing: ['local-gh-account'],
    })
  })

  it('blocks without the workflow scope', () => {
    const result = preflight({ ...ready(), localScopes: ['repo'] })
    expect(result).toMatchObject({ status: 'BLOCKED', missing: ['workflow-scope'] })
    if (result.status !== 'BLOCKED') return
    expect(result.actions[0]).toContain('gh auth refresh')
  })

  it('blocks with Actions disabled', () => {
    expect(preflight({ ...ready(), actionsEnabled: false })).toMatchObject({
      status: 'BLOCKED',
      missing: ['actions-disabled'],
    })
  })

  it('lists all four', () => {
    const result = preflight({
      ...ready(),
      repoStatus: 404,
      localLogin: null,
      localScopes: ['repo'],
      actionsEnabled: false,
    })
    expect(result.status).toBe('BLOCKED')
    if (result.status !== 'BLOCKED') return
    expect(result.missing).toHaveLength(4)
    expect(result.actions).toHaveLength(4)
  })

  it('labels the CI state', () => {
    expect(ciBlockedLabel(['workflow-scope'])).toBe('BLOCKED(no-workflow-scope)')
    expect(ciBlockedLabel(['actions-disabled'])).toBe('BLOCKED(actions-disabled)')
  })

  it('blocks an archived repository', () => {
    expect(preflight({ ...ready(), archived: true })).toMatchObject({ status: 'BLOCKED', missing: ['repo-archived'] })
  })

  it('blocks a token of another account', () => {
    expect(preflight({ ...ready(), tokenLogin: 'someone' })).toMatchObject({
      status: 'BLOCKED',
      missing: ['token-login'],
    })
    expect(preflight({ ...ready(), tokenLogin: null })).toMatchObject({ status: 'BLOCKED', missing: ['token-login'] })
    expect(preflight({ ...ready(), agentTokenLogin: 'someone' })).toMatchObject({
      status: 'BLOCKED',
      missing: ['agent-token-login'],
    })
    expect(preflight({ ...ready(), agentTokenLogin: 'EXAMPLE-AGENT' })).toEqual({ status: 'ready' })
  })

  it('local gh account follows the setting', () => {
    expect(preflight({ ...ready(), localLogin: 'example-owner' })).toEqual({ status: 'ready' })
    const result = preflight({ ...ready(), localLogin: 'someone' })
    expect(result.status).toBe('BLOCKED')
    if (result.status !== 'BLOCKED') return
    expect(result.actions.join('\n')).toContain('example-owner')
  })
})

describe('content rules', () => {
  it('flags milestone ids and the word', () => {
    for (const text of ['fixed in M' + '29', 'M' + '3', 'next Milestone', 'MILESTONE'])
      expect(contentProblems('x', text).length).toBeGreaterThan(0)
  })

  it('allows ordinary text', () => {
    for (const text of ['run-1a2b3c4d', 'mM1', 'HTML5', 'M.2', 'Fix truncate for exact lengths'])
      expect(contentProblems('x', text)).toEqual([])
  })

  it('commitProblems', () => {
    expect(commitProblems('fix: keep text that fits in truncate')).toEqual([])
    expect(commitProblems('Fix truncate').length).toBeGreaterThan(0)
    expect(commitProblems('fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>').length).toBeGreaterThan(0)
    expect(commitProblems('fix: done in M' + '29').length).toBeGreaterThan(0)
  })

  it('runTag', () => {
    expect(runTag(Buffer.from([1, 2, 3, 4]))).toBe('run-01020304')
    const tag = runTag()
    expect(tag).toMatch(/^run-[0-9a-f]{8}$/)
    expect(contentProblems('tag', tag)).toEqual([])
  })

  it('closesIssue', () => {
    expect(closesIssue('Fixes #12', 'example/playground', 12)).toBe(true)
    expect(closesIssue('Fixes #12', 'example/playground', 123)).toBe(false)
    expect(closesIssue('Closes https://github.com/example/playground/issues/7', 'example/playground', 7)).toBe(true)
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
    expect(changeVerdict(['api/src/http/cursor.ts', 'api/test/cursor.test.ts']).pass).toBe(true)
    expect(changeVerdict(['api/src/store/memory-store.ts'])).toMatchObject({ pass: false, reason: 'no-test' })
    expect(changeVerdict(['api/test/helpers.ts'])).toMatchObject({ pass: false, reason: 'no-source' })
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
    expect(
      seedPlan(
        expected,
        new Map([
          ['a.js', 'A'],
          ['b.js', 'B'],
          [WORKFLOW_PATH, 'W'],
          ['README.md', 'x'],
        ]),
      ),
    ).toEqual({ kind: 'unchanged' })
    const differs = seedPlan(
      expected,
      new Map([
        ['a.js', 'changed'],
        ['b.js', 'B'],
        [WORKFLOW_PATH, 'W'],
      ]),
    )
    expect(differs.kind).toBe('diff')
    if (differs.kind === 'diff') expect(differs.problems).toContain('a.js: content differs')
    expect(
      seedPlan(
        expected,
        new Map([
          ['a.js', 'A'],
          ['b.js', 'B'],
        ]),
      ),
    ).toEqual({ kind: 'create', paths: [WORKFLOW_PATH] })
    expect(seedPlan(expected, new Map([['a.js', 'A']])).kind).toBe('diff')
  })

  it('harnessMergesOnly', () => {
    const seed: HistoryCommit = { sha: 's0', commit: { message: SEED_MESSAGES.workflowUpdate } }
    const merge = (sha: string): HistoryCommit => ({ sha, commit: { message: 'fix: x (#7)' } })
    const pull = (sha: string, over: Partial<HarnessPull> = {}): HarnessPull => ({
      number: 7,
      merged_at: 't',
      merge_commit_sha: sha,
      head: { ref: 'agent/x' },
      user: { login: 'example-agent' },
      merged_by: { login: 'example-owner' },
      ...over,
    })
    const byShas = (...pulls: HarnessPull[]): Map<string, HarnessPull[]> =>
      new Map(pulls.map(p => [p.merge_commit_sha ?? '', [p]]))

    expect(harnessMergesOnly([merge('m2'), merge('m1'), seed], byShas(pull('m2'), pull('m1')), LOGINS)).toBe(true)
    const resetSeed: HistoryCommit = { sha: 's0', commit: { message: SEED_MESSAGES.reset } }
    expect(harnessMergesOnly([merge('m1'), resetSeed], byShas(pull('m1')), LOGINS)).toBe(true)

    expect(harnessMergesOnly([{ sha: 'h', commit: { message: 'docs: x' } }, seed], new Map(), LOGINS)).toBe(false)
    expect(
      harnessMergesOnly([merge('m1'), seed], byShas(pull('m1', { merged_by: { login: 'someone' } })), LOGINS),
    ).toBe(false)
    expect(harnessMergesOnly([merge('m1'), seed], byShas(pull('m1', { user: { login: 'someone' } })), LOGINS)).toBe(
      false,
    )
    expect(harnessMergesOnly([merge('m1'), seed], byShas(pull('m1', { head: { ref: 'feature/x' } })), LOGINS)).toBe(
      false,
    )
    expect(harnessMergesOnly([merge('m1'), seed], byShas(pull('m1', { merge_commit_sha: 'other' })), LOGINS)).toBe(
      false,
    )
    expect(harnessMergesOnly([merge('m1'), seed], byShas(pull('m1', { merged_at: null })), LOGINS)).toBe(false)
    const fifty = Array.from({ length: 50 }, (_, i) => merge('m' + i))
    expect(harnessMergesOnly([...fifty, seed], byShas(...fifty.map(c => pull(c.sha))), LOGINS)).toBe(false)
    expect(harnessMergesOnly([seed, merge('m1')], byShas(pull('m1')), LOGINS)).toBe(false)
  })

  it('harnessMergesOnly needs the configured logins', () => {
    const seed: HistoryCommit = { sha: 's0', commit: { message: SEED_MESSAGES.workflowUpdate } }
    const commits = [{ sha: 'm1', commit: { message: 'fix: x (#7)' } }, seed]
    const pulls = new Map([
      [
        'm1',
        [
          {
            number: 7,
            merged_at: 't',
            merge_commit_sha: 'm1',
            head: { ref: 'agent/x' },
            user: { login: 'example-agent' },
            merged_by: { login: 'example-owner' },
          },
        ],
      ],
    ])
    expect(harnessMergesOnly(commits, pulls, LOGINS)).toBe(true)
    expect(harnessMergesOnly(commits, pulls, { agentLogin: 'other-agent', ownerLogin: 'example-owner' })).toBe(false)
    expect(harnessMergesOnly(commits, pulls, { agentLogin: 'example-agent', ownerLogin: 'other' })).toBe(false)
  })

  it('seedPlan reset option', () => {
    const expected = [
      { path: 'a.js', content: 'A' },
      { path: 'b.js', content: 'B' },
      { path: WORKFLOW_PATH, content: 'W' },
    ]
    const opt = { harnessMergesOnly: true }
    expect(
      seedPlan(
        expected,
        new Map([
          ['a.js', 'changed'],
          [WORKFLOW_PATH, 'W'],
          ['README.md', 'x'],
        ]),
        opt,
      ),
    ).toEqual({ kind: 'reset', changed: ['a.js', 'b.js'], removed: ['README.md'] })
    expect(
      seedPlan(
        expected,
        new Map([
          ['a.js', 'A'],
          ['b.js', 'B'],
          [WORKFLOW_PATH, 'W'],
          ['.github/workflows/other.yml', 'o'],
        ]),
        opt,
      ),
    ).toEqual({ kind: 'unchanged' })
    expect(
      seedPlan(
        expected,
        new Map([
          ['a.js', 'A'],
          ['b.js', 'B'],
          [WORKFLOW_PATH, 'W'],
        ]),
        opt,
      ),
    ).toEqual({ kind: 'unchanged' })
    expect(seedPlan(expected, new Map(), opt)).toEqual({ kind: 'create', paths: ['a.js', 'b.js', WORKFLOW_PATH] })
    for (const o of [{}, { harnessMergesOnly: false }]) {
      expect(seedPlan(expected, new Map(), o)).toEqual({ kind: 'create', paths: ['a.js', 'b.js', WORKFLOW_PATH] })
      expect(
        seedPlan(
          expected,
          new Map([
            ['a.js', 'A'],
            ['b.js', 'B'],
            [WORKFLOW_PATH, 'W'],
            ['README.md', 'x'],
          ]),
          o,
        ),
      ).toEqual({ kind: 'unchanged' })
      expect(
        seedPlan(
          expected,
          new Map([
            ['a.js', 'A'],
            ['b.js', 'B'],
          ]),
          o,
        ),
      ).toEqual({ kind: 'create', paths: [WORKFLOW_PATH] })
      expect(seedPlan(expected, new Map([['a.js', 'A']]), o).kind).toBe('diff')
    }
    expect(
      seedPlan(
        expected,
        new Map([
          ['a.js', 'changed'],
          ['b.js', 'B'],
          [WORKFLOW_PATH, 'W'],
        ]),
      ).kind,
    ).toBe('diff')
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
    mutations.push(
      fixture.replace('      - run: npm ci\n', ''),
      fixture.replace(
        '      - run: npm run typecheck\n      - run: npm test',
        '      - run: npm test\n      - run: npm run typecheck',
      ),
      fixture.replace('node-version: 24', 'node-version: 22'),
    )
    for (const mutated of mutations) expect(seedWorkflowProblems(mutated).length).toBeGreaterThan(0)
    const secretProblems = (text: string) => seedWorkflowProblems(text).filter(p => p.includes('secrets'))
    expect(
      secretProblems(
        fixture.replace(
          '      - run: npm test',
          '      - run: npm test\n      - run: bash scripts/check-image-secrets.sh x',
        ),
      ),
    ).toEqual([])
    expect(
      secretProblems(
        fixture.replace('      - run: npm test', '      - run: npm test\n      - run: echo ${{ secrets.X }}'),
      ),
    ).toHaveLength(1)
  })
})

describe('fixtures', () => {
  const seedFiles = (): string[] =>
    readdirSync(SEED, { recursive: true })
      .map(String)
      .filter(entry => statSync(join(SEED, entry)).isFile())
  const apiFiles = (dir: string, ext: string): string[] =>
    seedFiles().filter(entry => entry.startsWith('api/' + dir + '/') && entry.endsWith(ext))

  it('seed files are clean', () => {
    for (const file of [...seedFiles().map(entry => join(SEED, entry)), WORKFLOW_FIXTURE]) {
      expect(contentProblems(file, readFileSync(file, 'utf8'))).toEqual([])
    }
  })

  it('workspace layout', () => {
    const root = readJson(join(SEED, 'package.json'))
    const rootScripts = root.scripts as Record<string, string>
    expect(root.private).toBe(true)
    expect(root.workspaces).toEqual(['api', 'web'])
    expect((root.engines as Record<string, string>).node).toBe('^24.15.0')
    expect(rootScripts.typecheck).toBe('npm run typecheck --workspaces --if-present')
    expect(rootScripts.test).toBe('npm test --workspaces --if-present')
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
      expect(root[key]).toBeUndefined()

    const api = readJson(join(SEED, 'api', 'package.json'))
    for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) expect(api[key]).toBeUndefined()
    expect(api.devDependencies).toEqual({ '@types/node': '22.20.5', typescript: '6.0.3' })
    expect((api.scripts as Record<string, string>).typecheck).toBe('tsc --noEmit')
    expect((api.scripts as Record<string, string>).test).toBe('node --test')

    const lockNames = [
      ...new Set(
        seedFiles()
          .map(entry => basename(entry))
          .filter(name => LOCK_NAMES.includes(name)),
      ),
    ]
    expect(lockNames).toEqual(['package-lock.json'])
    const lock = readJson(join(SEED, 'package-lock.json'))
    expect(lock.lockfileVersion).toBe(3)
    const packages = lock.packages as Record<string, { workspaces?: string[]; version?: string; optional?: boolean }>
    expect(packages['']?.workspaces).toEqual(['api', 'web'])
    expect(packages['node_modules/typescript']?.version).toBe('6.0.3')
    expect(packages['node_modules/@types/node']?.version).toBe('22.20.5')

    expect(loadSeed(false).length).toBeGreaterThanOrEqual(60)
    expect(loadSeed(false).length).toBeLessThanOrEqual(72)
    expect(apiFiles('src', '.ts').length).toBeGreaterThanOrEqual(22)
    expect(apiFiles('src', '.ts').length).toBeLessThanOrEqual(28)
    expect(apiFiles('test', '.ts').length).toBeGreaterThanOrEqual(10)
    expect(apiFiles('test', '.ts').length).toBeLessThanOrEqual(12)
  })

  it('seed version matches the fixture', () => {
    const files = loadSeed(false)
    const recorded = readFileSync(join(SEED, '.seed-version'), 'utf8').trim()
    expect(recorded).toBe(seedVersion(files))
    const changed = files.map(file => (file.path === 'README.md' ? { ...file, content: file.content + '\n' } : file))
    expect(seedVersion(changed)).not.toBe(recorded)
  })

  it('seed README states what the repository is', () => {
    expect(readmeProblems(readFileSync(join(SEED, 'README.md'), 'utf8'))).toEqual([])
  })

  it('seed typechecks with the pinned types', () => {
    const apiDev = (readJson(join(SEED, 'api', 'package.json')).devDependencies ?? {}) as Record<string, string>
    const rootTypescript = readJson(join(ROOT, 'node_modules', 'typescript', 'package.json')).version
    const rootTypes = readJson(join(ROOT, 'node_modules', '@types', 'node', 'package.json')).version
    if (rootTypescript !== apiDev.typescript || rootTypes !== apiDev['@types/node'])
      throw new Error('root and seed pins differ')
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(SEED, 'api', 'tsconfig.json'), '--noEmit'],
      { encoding: 'utf8' },
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  it('exactly one deprecated API in the seed source', () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(SEED, 'api', 'tsconfig.json'),
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
    )
    if (!parsed) throw new Error('seed tsconfig not readable')
    const sources = parsed.fileNames.filter(file => /[\\/]api[\\/]src[\\/].+\.ts$/.test(file))
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => parsed.fileNames,
      getScriptVersion: () => '1',
      getScriptSnapshot: file =>
        ts.sys.fileExists(file) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(file) ?? '') : undefined,
      getCurrentDirectory: () => join(SEED, 'api'),
      getCompilationSettings: () => parsed.options,
      getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    }
    const service = ts.createLanguageService(host)
    const deprecated = sources.flatMap(file =>
      service
        .getSuggestionDiagnostics(file)
        .filter(diagnostic => diagnostic.reportsDeprecated)
        .map(diagnostic => ({ file, text: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') })),
    )
    expect(deprecated.length).toBeGreaterThanOrEqual(1)
    expect(new Set(deprecated.map(entry => entry.file)).size).toBe(1)
    expect(
      deprecated.every(
        entry => entry.file.endsWith(join('api', 'src', 'log', 'line-buffer.ts')) && entry.text.includes('SlowBuffer'),
      ),
    ).toBe(true)
    const occurrences = sources.reduce(
      (count, file) => count + [...readFileSync(file, 'utf8').matchAll(/new SlowBuffer\(/g)].length,
      0,
    )
    expect(occurrences).toBe(1)
  })

  it('seed tests pass', async () => {
    const dir = scratch()
    try {
      cpSync(SEED, dir, { recursive: true })
      const result = await runNodeTests(dir)
      expect(result.code).toBe(0)
      expect(result.output).toMatch(/^(# |ℹ )fail 0$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('the paging defect is reproducible', async () => {
    const dir = scratch()
    try {
      cpSync(SEED, dir, { recursive: true })
      writeFileSync(join(dir, 'api', 'test', 'all-pages.test.ts'), ALL_PAGES_TEST)
      expect((await runNodeTests(dir)).code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('the date test fails only with a pinned clock', async () => {
    const dir = scratch()
    try {
      cpSync(SEED, dir, { recursive: true })
      const result = await runNodeTests(dir, 180_000, { FAKE_NOW: '2001-01-01T12:00:00Z' })
      expect(result.code).not.toBe(0)
      expect(result.output).toMatch(/^(# |ℹ )fail 1$/m)
      expect(result.output).toContain('a task due today counts as due today')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('partial update is not there yet', () => {
    expect(readFileSync(join(SEED, 'api', 'src', 'http', 'routes', 'tasks.ts'), 'utf8')).not.toContain('PATCH')
    expect(readFileSync(join(SEED, 'api', 'src', 'services', 'task-service.ts'), 'utf8')).not.toMatch(/\bupdate\s*\(/)
  })

  it('live config allows the npm registry and raises the limits', () => {
    const dir = scratch()
    try {
      const path = join(dir, 'superagent-claude.json')
      writeFileSync(
        path,
        JSON.stringify(
          liveConfig({ repo: 'example/playground', owner: 'example-owner', stateDir: join(dir, 'state') }),
        ),
      )
      const config = loadConfig(path, {})
      expect(config.network.allow).toContain('registry.npmjs.org')
      expect(config.workers.maxTurns).toBeGreaterThan(60)
      expect(config.workers.maxBudgetUsd).toBeGreaterThan(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('seed rules', () => {
  const README = readFileSync(join(SEED, 'README.md'), 'utf8')

  it('README rules reject a sample without each clause', () => {
    expect(readmeProblems(README)).toEqual([])
    expect(
      readmeProblems(README.replace('test playground for superagent-claude', 'sample repository')).length,
    ).toBeGreaterThan(0)
    expect(readmeProblems(README.replace('It is not a real project:', 'Note:')).length).toBeGreaterThan(0)
    expect(readmeProblems(README.replace('opened and closed by automated tests', 'welcome')).length).toBeGreaterThan(0)
  })

  it('seedVersion is stable under file order and changes with content', () => {
    const files = loadSeed(false)
    expect(seedVersion([...files].reverse())).toBe(seedVersion(files))
    const edited = files.map(file => (file.path === 'README.md' ? { ...file, content: file.content + 'x' } : file))
    expect(seedVersion(edited)).not.toBe(seedVersion(files))
  })

  it('attribution lines are rejected', () => {
    expect(attributionProblems('b', 'text\nCo-Authored-By: Claude <noreply@anthropic.com>').length).toBeGreaterThan(0)
    expect(attributionProblems('b', 'plain')).toEqual([])
  })
})

describe('ci verdict', () => {
  it('reports the check state', () => {
    expect(ciVerdict([])).toBe('none')
    expect(
      ciVerdict([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'success' },
      ]),
    ).toBe('success')
    expect(ciVerdict([{ status: 'in_progress', conclusion: null }])).toBe('pending')
    expect(ciVerdict([{ status: 'completed', conclusion: 'failure' }])).toBe('failure')
  })
})

describe('cleanup selection', () => {
  const issues = [
    { number: 1, state: 'open', user: { login: 'example-owner' } },
    { number: 2, state: 'open', user: { login: 'stranger' } },
    { number: 3, state: 'open', user: { login: 'example-owner' }, pull_request: {} },
    { number: 4, state: 'closed', user: { login: 'example-owner' } },
  ]
  const pulls = [
    { number: 5, state: 'open', user: { login: 'example-agent' }, head: { ref: 'agent/abc' } },
    { number: 6, state: 'open', user: { login: 'stranger' }, head: { ref: 'agent/keep' } },
    { number: 7, state: 'open', user: { login: 'example-owner' }, head: { ref: 'feature/x' } },
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
    const targets = cleanupTargets({
      repo: 'example/playground',
      defaultBranch: 'main',
      issues,
      pulls,
      branches,
      authors: ['example-owner', 'example-agent'],
      agent: 'example-agent',
    })
    expect(targets).toEqual({
      repo: 'example/playground',
      reportOnly: false,
      issues: [1],
      pulls: [5, 7],
      branches: ['agent/abc', 'agent/old'],
    })
  })

  it('reports only for the main repository', () => {
    const targets = cleanupTargets({
      repo: 'example/main',
      defaultBranch: 'main',
      issues,
      pulls,
      branches,
      authors: ['example-owner', 'example-agent'],
      agent: 'example-agent',
    })
    expect(targets).toEqual({
      repo: 'example/main',
      reportOnly: true,
      issues: [],
      pulls: [5, 6],
      branches: ['agent/abc', 'agent/keep', 'agent/old'],
    })
  })

  it('rejects other repositories', () => {
    expect(() =>
      cleanupTargets({
        repo: 'evil/x',
        defaultBranch: 'main',
        issues,
        pulls,
        branches,
        authors: ['example-owner'],
        agent: 'example-agent',
      }),
    ).toThrow()
  })

  it('report-only follows the setting', () => {
    stubLiveTarget({ ...EXAMPLE_TARGET_ENV })
    const base = {
      defaultBranch: 'main',
      issues,
      pulls,
      branches,
      authors: ['example-owner', 'example-agent'],
      agent: 'example-agent',
    }
    expect(cleanupTargets({ ...base, repo: 'example/main' }).reportOnly).toBe(true)
    expect(cleanupTargets({ ...base, repo: 'example/playground' }).reportOnly).toBe(false)
    expect(() => cleanupTargets({ ...base, repo: 'someone/playground' })).toThrow()
  })

  it('agent branch pattern', () => {
    expect(AGENT_BRANCH.test('agent/abc')).toBe(true)
    expect(AGENT_BRANCH.test('agent/')).toBe(false)
  })
})
