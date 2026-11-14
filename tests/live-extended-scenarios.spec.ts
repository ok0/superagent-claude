import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIXTURES_DIR,
  SEED_DIR,
  installWithRetry,
  npmCiArgs,
  runCommand,
  runHidden,
  type Install,
} from './live/hidden.ts'
import {
  MILESTONE_ID,
  MILESTONE_WORD,
  checkDiff,
  cleanupTargets,
  contentProblems,
  pullPatch,
  runNodeTests,
  seedVersion,
} from './live/rules.ts'
import type { DiffFile } from './live/rules.ts'
import { preparePull, preparedProblems, prepareProblems, prepareBranch } from './live/prepare-pr.ts'
import type { OwnerCall, PrepareSpec } from './live/prepare-pr.ts'
import { assertApiTarget } from './live/guard.ts'
import { SCENARIO_ENV, judgeScenario, loadAllScenarios, loadScenarios, renderScenario } from './live/scenarios.ts'
import type { LiveScenario } from './live/scenarios.ts'
import { requireLiveTarget } from './live/target.ts'
import { loadSeed } from './live/seed-playground.ts'
import { EXAMPLE_TARGET, EXAMPLE_TARGET_ENV, stubLiveTarget } from './fixtures/live-target.ts'

const ROOT = resolve(import.meta.dirname, '..')
const REFERENCE = join(FIXTURES_DIR, 'playground-reference')
const PREPARED = join(FIXTURES_DIR, 'playground-prepared', 'ci-failure', 'list-pages.test.ts')
const REPO = EXAMPLE_TARGET.repo
const PLAY_PATH = 'repos/' + REPO + '/'
const HIDDEN_TIMEOUT = 600_000
const EXT = ['ci-failure', 'flaky-date', 'types-node-major']
const CLOCK_NO_PIN = 'export function now(): Date {\n  return new Date()\n}\n'
const DUE_TITLE = "test('a task due today counts as due today'"

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'live-extended-'))
  dirs.push(dir)
  return dir
}

beforeEach(() => stubLiveTarget(EXAMPLE_TARGET_ENV))

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const copySeed = (dir: string, overlay?: string): void => {
  cpSync(SEED_DIR, dir, { recursive: true, filter: s => !s.split(sep).includes('node_modules') })
  if (overlay !== undefined) cpSync(join(REFERENCE, overlay), dir, { recursive: true })
}

const seedCopy = (overlay?: string): string => {
  const dir = tmp()
  copySeed(dir, overlay)
  return dir
}

const noInstall: Install = async () => ({ code: 0, output: 'skipped' })

const apiInstall: Install = (root, env, timeoutMs) =>
  runCommand('npm', ['ci', '--no-audit', '--no-fund', '--workspace', 'api'], { cwd: root, env, timeoutMs })

const byId = (scenarios: readonly LiveScenario[], id: string): LiveScenario => {
  const found = scenarios.find(s => s.id === id)
  if (!found) throw new Error('missing scenario ' + id)
  return found
}

const readLock = (path: string): { packages: Record<string, Record<string, unknown> | undefined> } =>
  JSON.parse(readFileSync(path, 'utf8'))

const withoutDueTest = (text: string): string => text.slice(0, text.indexOf(DUE_TITLE))

const change = (filename: string): DiffFile => ({ filename, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' })

const fakeOwner = (): { call: OwnerCall; calls: { args: string[]; input: string }[]; order: string[] } => {
  const calls: { args: string[]; input: string }[] = []
  const order: string[] = []
  const answer = (path: string): unknown => {
    if (path === 'git/commits/base0') return { tree: { sha: 't0' } }
    if (path === 'git/blobs') return { sha: 'b1' }
    if (path === 'git/trees') return { sha: 't1' }
    if (path === 'git/commits') return { sha: 'c1' }
    if (path === 'git/refs') return {}
    if (path === 'pulls') return { number: 7, html_url: 'u' }
    if (path === 'issues/7/comments') return { html_url: 'cu', created_at: '2026-11-11T00:00:00Z' }
    throw new Error('unexpected endpoint ' + path)
  }
  const call = (async (args: string[], options?: { input?: string }): Promise<any> => {
    calls.push({ args, input: options?.input ?? '' })
    const endpoint = args[0] ?? ''
    order.push(endpoint)
    return answer(endpoint.slice(PLAY_PATH.length))
  }) as OwnerCall
  return { call, calls, order }
}

const renderedCiSpec = async (): Promise<{ scenario: LiveScenario; spec: PrepareSpec }> => {
  const scenario = renderScenario(byId(await loadAllScenarios(), 'ci-failure'), requireLiveTarget())
  if (!scenario.prepare) throw new Error('ci-failure has no prepare block')
  return { scenario, spec: scenario.prepare }
}

const ciSpec = async (): Promise<{ scenario: LiveScenario; spec: PrepareSpec }> => {
  const scenario = byId(await loadAllScenarios(), 'ci-failure')
  if (!scenario.prepare) throw new Error('ci-failure has no prepare block')
  return { scenario, spec: scenario.prepare }
}

describe('extended scenarios', () => {
  it('extended scenarios are opt-in', async () => {
    const core = (await loadScenarios({})).map(s => s.id)
    for (const id of EXT) expect(core).not.toContain(id)
    const selected = await loadScenarios({ [SCENARIO_ENV]: EXT.join(',') })
    for (const id of EXT) expect(byId(selected, id).tier).toBe('extended')
    const one = await loadScenarios({ [SCENARIO_ENV]: 'flaky-date' })
    expect(one.filter(s => s.tier === 'extended').map(s => s.id)).toEqual(['flaky-date'])
  })

  it('texts are clean and mention the agent', async () => {
    const all = await loadAllScenarios()
    const texts: string[] = []
    for (const id of EXT) {
      const s = byId(all, id)
      expect(contentProblems('title', s.issue.title)).toEqual([])
      expect(contentProblems('body', s.issue.body)).toEqual([])
      texts.push(s.issue.title, s.issue.body)
      if (s.prepare) texts.push(s.prepare.comment, s.prepare.commitMessage)
    }
    for (const id of ['flaky-date', 'types-node-major'])
      expect(byId(all, id).issue.body.startsWith('@{{agent}} ')).toBe(true)
    const { scenario, spec } = await ciSpec()
    expect(spec.comment.startsWith('@{{agent}} ')).toBe(true)
    const rendered = renderScenario(scenario, EXAMPLE_TARGET)
    expect(rendered.issue.body.includes('{{agent}}')).toBe(false)
    expect(
      prepareProblems({
        spec: rendered.prepare as PrepareSpec,
        title: rendered.issue.title,
        body: rendered.issue.body,
        branch: prepareBranch('run-0a1b2c3d'),
        agent: EXAMPLE_TARGET.agentLogin,
      }),
    ).toEqual([])
    for (const text of texts)
      expect(text).not.toMatch(/cursor|memory-store|task-service|due\.test|clock|FAKE_NOW|SlowBuffer/i)
  })

  it(
    '(e) hidden fails in every entry on the seed',
    async () => {
      const e = byId(await loadAllScenarios(), 'flaky-date')
      const result = await runHidden('base', e, { fetchTree: async (_, d) => copySeed(d), install: noInstall })
      expect(result.passed).toBe(false)
      expect(result.runs).toBe(9)
      expect(result.exits).toHaveLength(9)
      expect(result.exits.every(r => r.code !== 0)).toBe(true)
      expect(new Set(result.exits.map(r => JSON.stringify(r.env))).size).toBe(3)
    },
    HIDDEN_TIMEOUT,
  )

  it(
    '(e) reference passes nine runs',
    async () => {
      const e = byId(await loadAllScenarios(), 'flaky-date')
      const result = await runHidden('head', e, {
        fetchTree: async (_, d) => copySeed(d, 'flaky-date'),
        install: noInstall,
      })
      expect(result.passed).toBe(true)
      expect(result.runs).toBe(9)
      expect(result.exits).toHaveLength(9)
      expect(result.exits.every(r => r.code === 0)).toBe(true)
    },
    HIDDEN_TIMEOUT,
  )

  it(
    '(e) dropping clock support fails',
    async () => {
      const e = byId(await loadAllScenarios(), 'flaky-date')
      const result = await runHidden('head', e, {
        fetchTree: async (_, d) => {
          copySeed(d, 'flaky-date')
          writeFileSync(join(d, 'api/src/config/clock.ts'), CLOCK_NO_PIN)
        },
        install: noInstall,
      })
      expect(result.passed).toBe(false)
    },
    HIDDEN_TIMEOUT,
  )

  it(
    '(e) deleting or skipping the date test passes hidden but fails the diff',
    async () => {
      const e = byId(await loadAllScenarios(), 'flaky-date')
      const seedDue = readFileSync(join(SEED_DIR, 'api/test/due.test.ts'), 'utf8')
      const deleted = withoutDueTest(seedDue)
      const onDeleted = await runHidden('head', e, {
        fetchTree: async (_, d) => {
          copySeed(d)
          writeFileSync(join(d, 'api/test/due.test.ts'), deleted)
        },
        install: noInstall,
      })
      expect(onDeleted.passed).toBe(true)
      const removed: DiffFile[] = [
        {
          filename: 'api/test/due.test.ts',
          status: 'modified',
          patch:
            "@@ -27,3 +27,0 @@\n-test('a task due today counts as due today', () => {\n-  assert.equal(isDueToday({ dueDate: dayKey(new Date()) }), true)\n-})",
        },
      ]
      const deletedVerdict = checkDiff(removed, pullPatch(removed), e.diff)
      expect(deletedVerdict.pass).toBe(false)
      expect(deletedVerdict.reasons).toContain('test count decreased by 1')

      const skipped = seedDue.replace(DUE_TITLE, "test.skip('a task due today counts as due today'")
      const onSkipped = await runHidden('head', e, {
        fetchTree: async (_, d) => {
          copySeed(d)
          writeFileSync(join(d, 'api/test/due.test.ts'), skipped)
        },
        install: noInstall,
      })
      expect(onSkipped.passed).toBe(true)
      const skipFiles: DiffFile[] = [
        {
          filename: 'api/test/due.test.ts',
          status: 'modified',
          patch:
            "@@ -27,1 +27,1 @@\n-test('a task due today counts as due today', () => {\n+test.skip('a task due today counts as due today', () => {",
        },
      ]
      const skipVerdict = checkDiff(skipFiles, pullPatch(skipFiles), e.diff)
      expect(skipVerdict.pass).toBe(false)
      expect(skipVerdict.reasons).toContain('new skip/only/todo: api/test/due.test.ts')
    },
    HIDDEN_TIMEOUT,
  )

  it(
    '(d) prepared test fails on the seed and passes with the reference',
    async () => {
      const d = byId(await loadAllScenarios(), 'ci-failure')
      const onSeed = seedCopy()
      cpSync(PREPARED, join(onSeed, 'api/test/list-pages.test.ts'))
      expect((await runNodeTests(join(onSeed, 'api'))).code).not.toBe(0)

      const onReference = seedCopy('ci-failure')
      cpSync(PREPARED, join(onReference, 'api/test/list-pages.test.ts'))
      expect((await runNodeTests(join(onReference, 'api'))).code).toBe(0)

      const hidden = await runHidden('head', d, {
        fetchTree: async (_, dir) => {
          copySeed(dir, 'ci-failure')
          cpSync(PREPARED, join(dir, 'api/test/list-pages.test.ts'))
        },
        install: noInstall,
      })
      expect(hidden.passed).toBe(true)

      const typed = seedCopy()
      cpSync(PREPARED, join(typed, 'api/test/list-pages.test.ts'))
      symlinkSync(join(ROOT, 'node_modules'), join(typed, 'node_modules'), 'dir')
      const res = spawnSync(
        process.execPath,
        [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(typed, 'api/tsconfig.json'), '--noEmit'],
        { encoding: 'utf8' },
      )
      expect(res.status, res.stdout + res.stderr).toBe(0)
    },
    HIDDEN_TIMEOUT,
  )

  it('(d) verdict needs the prepared test intact', async () => {
    const d = byId(await loadAllScenarios(), 'ci-failure')
    const fixture = readFileSync(PREPARED, 'utf8')
    expect(preparedProblems(fixture, null)).toEqual(['prepared test missing'])
    expect(preparedProblems(fixture, fixture.replace("test('", "test.skip('"))).toEqual(['prepared test changed'])

    const base = { checks: 'success', hidden: { passed: true }, diff: { pass: true }, base: null }
    expect(judgeScenario(d, { ...base, prepared: { passed: false } })).toEqual({ passed: false, failed: ['prepared'] })
    expect(judgeScenario(d, { ...base, prepared: { passed: true } })).toEqual({ passed: true, failed: [] })

    const rule = d.diff
    const hiddenDest = d.hidden?.dest
    if (!hiddenDest) throw new Error('ci-failure has no hidden dest')
    const single = (filename: string, status = 'modified'): DiffFile[] => [
      { filename, status, patch: "@@ -0,0 +1 @@\n+test('x', () => {})" },
    ]
    expect(
      checkDiff(single('web/src/main.tsx'), pullPatch(single('web/src/main.tsx')), rule).reasons.join('\n'),
    ).toMatch(/outside allowed roots/)
    expect(
      checkDiff(
        single('.github/workflows/test.yml'),
        pullPatch(single('.github/workflows/test.yml')),
        rule,
      ).reasons.join('\n'),
    ).toMatch(/CI workflow changed/)
    const hiddenFiles = single('api/test/hidden-acceptance/x.test.ts', 'added')
    expect(checkDiff(hiddenFiles, pullPatch(hiddenFiles), rule, { hiddenDest }).reasons.join('\n')).toMatch(
      /hidden test path changed/,
    )
    const pair: DiffFile[] = [
      { filename: 'api/src/services/task-service.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { filename: 'api/test/list-pages.test.ts', status: 'added', patch: "@@ -0,0 +1 @@\n+test('x', () => {})" },
    ]
    expect(checkDiff(pair, pullPatch(pair), rule)).toEqual({ pass: true, reasons: [] })
  })

  it('the prepare helper stays on the playground', async () => {
    const { scenario, spec } = await renderedCiSpec()
    const branch = prepareBranch('run-0a1b2c3d')
    const owner = fakeOwner()
    const created: { number: number; ref: string }[] = []
    const pull = await preparePull({
      call: owner.call,
      repo: REPO,
      base: { branch: 'main', sha: 'base0' },
      branch,
      spec,
      title: scenario.issue.title,
      body: scenario.issue.body,
      content: readFileSync(PREPARED, 'utf8'),
      agent: EXAMPLE_TARGET.agentLogin,
      checksOf: async () => {
        owner.order.push('checks')
        return 'failure'
      },
      onCreated: p => created.push(p),
    })
    expect(pull.number).toBe(7)
    for (const c of owner.calls) {
      expect(c.args[0]?.startsWith(PLAY_PATH)).toBe(true)
      expect(() => assertApiTarget(c.args)).not.toThrow()
      expect(c.input).not.toContain('force')
    }
    const tree = owner.calls.find(c => c.args[0] === PLAY_PATH + 'git/trees')
    const entries = (JSON.parse(tree?.input ?? '{}') as { tree: { path: string }[] }).tree
    expect(entries).toHaveLength(1)
    expect(entries[0]?.path).toBe('api/test/list-pages.test.ts')
    const refCall = owner.calls.find(c => c.args[0] === PLAY_PATH + 'git/refs')
    const ref = (JSON.parse(refCall?.input ?? '{}') as { ref: string }).ref
    expect(ref).toBe('refs/heads/' + branch)
    expect(ref).not.toMatch(MILESTONE_ID)
    expect(ref).not.toMatch(MILESTONE_WORD)
    const checksAt = owner.order.indexOf('checks')
    expect(checksAt).toBeGreaterThanOrEqual(0)
    expect(owner.order.indexOf(PLAY_PATH + 'issues/7/comments')).toBeGreaterThan(checksAt)
    expect(created).toEqual([{ number: 7, ref: branch }])
    expect(
      cleanupTargets({
        repo: REPO,
        defaultBranch: 'main',
        issues: [],
        pulls: [{ number: 7, state: 'open', user: { login: EXAMPLE_TARGET.ownerLogin }, head: { ref: branch } }],
        branches: [{ name: branch }],
        authors: [EXAMPLE_TARGET.ownerLogin, EXAMPLE_TARGET.agentLogin],
        agent: EXAMPLE_TARGET.agentLogin,
      }),
    ).toMatchObject({ pulls: [7], branches: [branch] })
  })

  it('the prepare helper refuses other repositories and green checks', async () => {
    const { spec, scenario } = await renderedCiSpec()
    const branch = prepareBranch('run-0a1b2c3d')
    const input = (owner: ReturnType<typeof fakeOwner>, onCreated: (p: { number: number; ref: string }) => void) => ({
      call: owner.call,
      repo: REPO,
      base: { branch: 'main', sha: 'base0' },
      branch,
      spec,
      title: scenario.issue.title,
      body: scenario.issue.body,
      content: readFileSync(PREPARED, 'utf8'),
      agent: EXAMPLE_TARGET.agentLogin,
      checksOf: async () => {
        owner.order.push('checks')
        return 'failure'
      },
      onCreated,
    })

    const foreign = fakeOwner()
    await expect(preparePull({ ...input(foreign, () => {}), repo: 'someone/else' })).rejects.toThrow()
    expect(foreign.calls).toHaveLength(0)

    const green = fakeOwner()
    const greenCreated: { number: number; ref: string }[] = []
    await expect(
      preparePull({ ...input(green, p => greenCreated.push(p)), checksOf: async () => 'success' }),
    ).rejects.toThrow(/expected failure/)
    expect(greenCreated).toHaveLength(1)
    expect(green.calls.some(c => c.args[0] === PLAY_PATH + 'issues/7/comments')).toBe(false)
  })

  it('(f) reference lockfile changes only @types/node', () => {
    const seedLock = readLock(join(SEED_DIR, 'package-lock.json'))
    const refLock = readLock(join(REFERENCE, 'types-node-major', 'package-lock.json'))
    const keys = new Set([...Object.keys(seedLock.packages), ...Object.keys(refLock.packages)])
    for (const key of keys) {
      if (JSON.stringify(seedLock.packages[key]) === JSON.stringify(refLock.packages[key])) continue
      expect(key === 'api' || key.includes('@types/node') || key.includes('undici-types'), key).toBe(true)
    }
    expect(refLock.packages['']?.workspaces).toEqual(seedLock.packages['']?.workspaces)
  })

  it('(f) diff rule', async () => {
    const f = byId(await loadAllScenarios(), 'types-node-major')
    const verdict = (files: DiffFile[]) => checkDiff(files, pullPatch(files), f.diff)
    const bump = [change('api/package.json'), change('package-lock.json'), change('api/src/log/line-buffer.ts')]
    expect(verdict(bump)).toEqual({ pass: true, reasons: [] })
    expect(verdict([...bump, change('.github/workflows/test.yml')]).pass).toBe(false)
    expect(verdict([...bump, change('web/src/main.tsx')]).pass).toBe(false)
    expect(verdict([...bump, change('package.json')]).reasons).toContain('outside allowed roots: package.json')
  })

  it('extended scenarios leave the seed and the core scenarios alone', async () => {
    const pick = (s: LiveScenario) => ({ id: s.id, tier: s.tier, kind: s.kind, hidden: s.hidden, diff: s.diff })
    const byIdCompare = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const CORE_EXPECTED = [
      {
        id: 'bug-paging',
        tier: 'core',
        kind: 'bug',
        hidden: {
          dir: 'playground-hidden/bug-paging',
          dest: 'api/test/hidden-acceptance',
          workspace: 'api',
          command: ['node', '--test', 'test/hidden-acceptance/*.test.ts'],
        },
        diff: { requireSourceAndTest: true, allowedRoots: ['api/'], allowLockfile: false, newTestFailsOnBase: true },
      },
      {
        id: 'feature-partial-update',
        tier: 'core',
        kind: 'feature',
        hidden: {
          dir: 'playground-hidden/feature-partial-update',
          dest: 'api/test/hidden-acceptance',
          workspace: 'api',
          command: ['node', '--test', 'test/hidden-acceptance/*.test.ts'],
        },
        diff: { requireSourceAndTest: true, allowedRoots: ['api/'], allowLockfile: false },
      },
      {
        id: 'review-limit-validation',
        tier: 'core',
        kind: undefined,
        hidden: {
          dir: 'playground-hidden/bug-paging',
          dest: 'api/test/hidden-acceptance',
          workspace: 'api',
          command: ['node', '--test', 'test/hidden-acceptance/*.test.ts'],
        },
        diff: { requireSourceAndTest: true, allowedRoots: ['api/'], allowLockfile: false },
      },
      {
        id: 'ui-overdue-rows',
        tier: 'core',
        kind: 'ui',
        hidden: {
          dir: 'playground-hidden/ui-overdue-rows',
          dest: 'web/src/hidden-acceptance',
          workspace: 'web',
          command: ['node', '../node_modules/vitest/vitest.mjs', 'run', 'src/hidden-acceptance/'],
          envMatrix: [{ TZ: 'UTC' }, { TZ: 'Pacific/Kiritimati' }, { TZ: 'Pacific/Pago_Pago' }],
        },
        diff: { requireSourceAndTest: true, allowedRoots: ['web/'], allowLockfile: false },
      },
      {
        id: 'ui-polish-list',
        tier: 'core',
        kind: 'ui',
        diff: { requireSourceAndTest: false, requireSource: true, allowedRoots: ['web/'], allowLockfile: false },
      },
    ]
    expect(seedVersion(loadSeed(false))).toBe(readFileSync(join(SEED_DIR, '.seed-version'), 'utf8').trim())
    for (const s of (await loadAllScenarios()).filter(s => s.tier === 'extended')) {
      const assets = [
        s.hidden ? join(FIXTURES_DIR, s.hidden.dir) : undefined,
        s.prepare ? join(FIXTURES_DIR, s.prepare.fixture) : undefined,
        join(REFERENCE, s.id),
      ]
      for (const asset of assets) {
        if (asset === undefined) continue
        expect(asset).not.toBe(SEED_DIR)
        expect(asset.startsWith(SEED_DIR + sep)).toBe(false)
      }
    }
    expect((await loadScenarios({})).map(pick).sort(byIdCompare)).toEqual(CORE_EXPECTED)
    const ids = EXT
    expect(
      (await loadScenarios({ [SCENARIO_ENV]: ids.join(',') }))
        .filter(s => s.tier === 'core')
        .map(pick)
        .sort(byIdCompare),
    ).toEqual(CORE_EXPECTED)
  })

  it('the live spec runs the prepared flow', () => {
    const text = readFileSync(join(ROOT, 'tests/live/code-change.spec.ts'), 'utf8')
    for (const needle of ['preparePull(', 'preparedProblems(', '/compare/']) expect(text).toContain(needle)
  })
})

describe('install retry offline', () => {
  const NET = 'npm error code ETIMEDOUT\nnpm error network read ETIMEDOUT'
  const CI = 'npm error code EUSAGE\nnpm ci can only install with an existing package-lock.json'
  const scripted = (
    ...results: { code: number; output: string }[]
  ): { install: Install; calls: { timeoutMs: number; env: Readonly<Record<string, string>> }[] } => {
    const calls: { timeoutMs: number; env: Readonly<Record<string, string>> }[] = []
    const install: Install = async (_root, env, timeoutMs) => {
      calls.push({ timeoutMs, env })
      return results[Math.min(calls.length - 1, results.length - 1)]!
    }
    return { install, calls }
  }
  const flaky = async (): Promise<LiveScenario> => byId(await loadAllScenarios(), 'flaky-date')

  it('retries network failures and proceeds when a later attempt installs', async () => {
    const { install, calls } = scripted(
      { code: 1, output: NET },
      { code: 1, output: NET },
      { code: 0, output: 'added' },
    )
    const waits: number[] = []
    const outcome = await installWithRetry('/root', {}, () => 600_000, {
      install,
      sleep: async ms => {
        waits.push(ms)
      },
    })
    expect(outcome).toMatchObject({ ok: true, code: 0, environment: false })
    expect(outcome.attempts.map(a => a.networkError)).toEqual([true, true, false])
    expect(waits).toEqual([5000, 15000])
    expect(calls).toHaveLength(3)
  })

  it('reports an environment failure after three network attempts and never a fourth', async () => {
    const { install, calls } = scripted({ code: 1, output: NET })
    const waits: number[] = []
    const outcome = await installWithRetry('/root', {}, () => 600_000, {
      install,
      sleep: async ms => {
        waits.push(ms)
      },
    })
    expect(outcome).toMatchObject({ ok: false, environment: true })
    expect(outcome.attempts).toHaveLength(3)
    expect(calls).toHaveLength(3)
    expect(waits).toEqual([5000, 15000])
  })

  it('a non-network install failure is not retried and is not an environment failure', async () => {
    const { install, calls } = scripted({ code: 1, output: CI })
    const result = await runHidden('head', await flaky(), {
      fetchTree: async (_, d) => copySeed(d, 'flaky-date'),
      install,
      cacheDir: tmp(),
      sleep: async () => {},
    })
    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({ passed: false, runs: 0, install: { environment: false, failed: true } })
    expect(result.install!.attempts).toHaveLength(1)
    expect(result.output.startsWith('install failed')).toBe(true)
  })

  it('a network failure followed by a non-network failure stops at two attempts and is not an environment failure', async () => {
    const { install, calls } = scripted({ code: 1, output: 'npm error code ECONNRESET' }, { code: 1, output: CI })
    const outcome = await installWithRetry('/root', {}, () => 600_000, { install, sleep: async () => {} })
    expect(calls).toHaveLength(2)
    expect(outcome.ok).toBe(false)
    expect(outcome.environment).toBe(false)
  })

  it('does not start another attempt or sleep past the deadline', async () => {
    let left = 4000
    const waits: number[] = []
    const install: Install = async () => {
      left -= 3000
      return { code: 1, output: NET }
    }
    const outcome = await installWithRetry('/root', {}, () => left, {
      install,
      sleep: async ms => {
        waits.push(ms)
      },
    })
    expect(outcome.attempts).toHaveLength(1)
    expect(waits).toEqual([])
  })

  it('reuses the npm cache across runs and keeps it out of the throwaway HOME', async () => {
    const cacheDir = tmp()
    const seen: Readonly<Record<string, string>>[] = []
    const install: Install = async (_root, env) => {
      seen.push(env)
      return { code: 1, output: CI }
    }
    const scenario = await flaky()
    for (let i = 0; i < 2; i++)
      await runHidden('head', scenario, { fetchTree: async (_, d) => copySeed(d, 'flaky-date'), install, cacheDir })
    expect(seen).toHaveLength(2)
    expect(seen[0]!.npm_config_cache).toBe(cacheDir)
    expect(seen[1]!.npm_config_cache).toBe(cacheDir)
    expect(seen[0]!.HOME).not.toBe(seen[1]!.HOME)
    expect(cacheDir.startsWith(seen[0]!.HOME!)).toBe(false)
  })

  it(
    'a recovered install runs the hidden tests and records the attempts',
    async () => {
      const { install } = scripted({ code: 1, output: NET }, { code: 1, output: NET }, { code: 0, output: 'added' })
      const waits: number[] = []
      const result = await runHidden('head', await flaky(), {
        fetchTree: async (_, d) => copySeed(d, 'flaky-date'),
        install,
        cacheDir: tmp(),
        sleep: async ms => {
          waits.push(ms)
        },
      })
      expect(result.runs).toBeGreaterThan(0)
      expect(result.install).toMatchObject({ environment: false, failed: false })
      expect(result.install!.attempts).toHaveLength(3)
      expect(waits).toEqual([5000, 15000])
    },
    HIDDEN_TIMEOUT,
  )

  it('npm ci passes fetch timeout and retry flags', () => {
    expect(npmCiArgs[0]).toBe('ci')
    expect(npmCiArgs.some(a => a.startsWith('--fetch-timeout='))).toBe(true)
    expect(npmCiArgs.some(a => a.startsWith('--fetch-retries='))).toBe(true)
  })
})

describe.skipIf(process.env.ISSUECREW_SEED_INSTALL !== '1')('extended hidden tests with a real install', () => {
  it(
    '(f) bump only fails typecheck on SlowBuffer',
    async () => {
      const f = byId(await loadAllScenarios(), 'types-node-major')
      const result = await runHidden('head', f, {
        fetchTree: async (_, d) => {
          copySeed(d)
          for (const file of ['package-lock.json', 'api/package.json'])
            cpSync(join(REFERENCE, 'types-node-major', file), join(d, file))
        },
        install: apiInstall,
      })
      expect(result.passed).toBe(false)
      expect(result.runs).toBe(1)
      expect(result.output).toMatch(/SlowBuffer/)
    },
    HIDDEN_TIMEOUT,
  )

  it(
    '(f) reference passes',
    async () => {
      const f = byId(await loadAllScenarios(), 'types-node-major')
      const result = await runHidden('head', f, {
        fetchTree: async (_, d) => copySeed(d, 'types-node-major'),
        install: apiInstall,
      })
      expect(result.passed).toBe(true)
    },
    HIDDEN_TIMEOUT,
  )

  it(
    '(f) staying on 22 fails',
    async () => {
      const f = byId(await loadAllScenarios(), 'types-node-major')
      const result = await runHidden('head', f, { fetchTree: async (_, d) => copySeed(d), install: apiInstall })
      expect(result.passed).toBe(false)
    },
    HIDDEN_TIMEOUT,
  )

  it(
    '(f) package.json and lockfile out of sync fails',
    async () => {
      const f = byId(await loadAllScenarios(), 'types-node-major')
      const result = await runHidden('head', f, {
        fetchTree: async (_, d) => {
          copySeed(d)
          cpSync(join(REFERENCE, 'types-node-major', 'package-lock.json'), join(d, 'package-lock.json'))
        },
        install: apiInstall,
      })
      expect(result.passed).toBe(false)
      expect(result.runs).toBe(0)
      expect(result.output.startsWith('install failed')).toBe(true)
    },
    HIDDEN_TIMEOUT,
  )
})
