import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkDiff, contentProblems, patchSections, pullPatch } from './live/rules.ts'
import type { DiffFile, DiffRule } from './live/rules.ts'
import { FIXTURES_DIR, SEED_DIR, runHidden, testsFailOnBase, type Install } from './live/hidden.ts'
import {
  SCENARIO_ENV,
  judgeScenario,
  loadAllScenarios,
  loadScenarios,
  renderScenario,
  scenarioFlows,
  scenarioProblems,
  scenarioTexts,
} from './live/scenarios.ts'
import { EXAMPLE_TARGET } from './fixtures/live-target.ts'
import type { HiddenSpec, LiveScenario } from './live/scenarios.ts'
import { loadSeed } from './live/seed-playground.ts'

const ROOT = resolve(import.meta.dirname, '..')
const REFERENCE = join(FIXTURES_DIR, 'playground-reference')

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'live-scenarios-'))
  dirs.push(dir)
  return dir
}

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

const fetchApi = async (_sha: string, dir: string): Promise<void> => {
  mkdirSync(join(dir, 'api'), { recursive: true })
}

const scenarioSource = (id: string, tier: string): string =>
  "export const scenario = { id: '" +
  id +
  "', tier: '" +
  tier +
  "', issue: { title: 'T " +
  id +
  "', body: 'B " +
  id +
  "' }, diff: { requireSourceAndTest: true } }\n"

function writeScenarios(files: Record<string, string>): string {
  const dir = tmp()
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

const byId = (scenarios: readonly LiveScenario[], id: string): LiveScenario => {
  const found = scenarios.find(s => s.id === id)
  if (!found) throw new Error('missing scenario ' + id)
  return found
}

const probe = (command: readonly string[], extra: Partial<HiddenSpec> = {}): LiveScenario => ({
  id: 'probe',
  tier: 'extended',
  issue: { title: 'probe', body: 'probe' },
  diff: { requireSourceAndTest: false },
  hidden: { dir: 'h/x', dest: 'api/hidden', workspace: 'api', command, ...extra },
})

const fixtures = (): string => {
  const fx = join(tmp(), 'fx')
  mkdirSync(join(fx, 'h', 'x'), { recursive: true })
  writeFileSync(join(fx, 'h', 'x', 'marker.txt'), 'marker')
  return fx
}

const CURSOR_TEST = [
  "import assert from 'node:assert/strict'",
  "import { test } from 'node:test'",
  "import { decodeCursor, encodeCursor } from '../src/http/cursor.ts'",
  '',
  "test('cursor round trip', () => {",
  '  assert.equal(decodeCursor(encodeCursor(3)), 3)',
  '})',
  '',
].join('\n')

const PAGING_TEST = [
  "import assert from 'node:assert/strict'",
  "import { test } from 'node:test'",
  "import { createTaskService } from '../src/services/task-service.ts'",
  "import { createMemoryStore } from '../src/store/memory-store.ts'",
  '',
  "test('paging with limit 2 reaches all five tasks', () => {",
  '  const service = createTaskService({ store: createMemoryStore() })',
  '  for (let i = 1; i <= 5; i++) service.create({ title: "Task " + i }, "u1")',
  '  let start = 0',
  '  let total = 0',
  '  for (let n = 0; n < 10; n++) {',
  '    const page = service.list({ start, limit: 2 })',
  '    total += page.items.length',
  '    if (page.next === null) break',
  '    start = page.next',
  '  }',
  '  assert.equal(total, 5)',
  '})',
  '',
].join('\n')

describe('scenario registry', () => {
  it('a file in the directory is enough to add a scenario', async () => {
    const dir = writeScenarios({ 'alpha.ts': scenarioSource('alpha', 'core') })
    expect((await loadScenarios({}, dir)).map(s => s.id)).toEqual(['alpha'])
    writeFileSync(join(dir, 'beta.ts'), scenarioSource('beta', 'core'))
    expect((await loadScenarios({}, dir)).map(s => s.id)).toEqual(['alpha', 'beta'])
  })

  it('without the selection only core scenarios load', async () => {
    const dir = writeScenarios({
      'alpha.ts': scenarioSource('alpha', 'core'),
      'ext-one.ts': scenarioSource('ext-one', 'extended'),
      'ext-two.ts': scenarioSource('ext-two', 'extended'),
    })
    expect((await loadScenarios({}, dir)).map(s => s.id)).toEqual(['alpha'])
    expect((await loadScenarios({ [SCENARIO_ENV]: '' }, dir)).map(s => s.id)).toEqual(['alpha'])
  })

  it('a selection adds the named extended scenarios', async () => {
    const dir = writeScenarios({
      'alpha.ts': scenarioSource('alpha', 'core'),
      'ext-one.ts': scenarioSource('ext-one', 'extended'),
      'ext-two.ts': scenarioSource('ext-two', 'extended'),
    })
    expect((await loadScenarios({ [SCENARIO_ENV]: 'ext-two, alpha' }, dir)).map(s => s.id)).toEqual([
      'alpha',
      'ext-two',
    ])
  })

  it('an unknown id is an error', async () => {
    const dir = writeScenarios({ 'alpha.ts': scenarioSource('alpha', 'core') })
    await expect(loadScenarios({ [SCENARIO_ENV]: 'nope' }, dir)).rejects.toThrow(/unknown scenario: nope/)
  })

  it('a duplicate id is an error', async () => {
    const dir = writeScenarios({ 'one.ts': scenarioSource('same', 'core'), 'two.ts': scenarioSource('same', 'core') })
    await expect(loadScenarios({}, dir)).rejects.toThrow(/duplicate scenario id: same/)
  })

  it('a module without a scenario export is an error', async () => {
    const dir = writeScenarios({ 'bare.ts': 'export const other = 1\n' })
    await expect(loadScenarios({}, dir)).rejects.toThrow(/no scenario export/)
  })

  it('scenarioProblems accepts a valid sample and rejects broken ones', () => {
    const valid = { id: 'ok-one', tier: 'core', issue: { title: 'T', body: 'B' }, diff: { requireSourceAndTest: true } }
    expect(scenarioProblems(valid)).toEqual([])
    const hidden = { dir: 'h/x', dest: 'api/hidden', workspace: 'api', command: ['node'] }
    const broken: unknown[] = [
      { ...valid, tier: 'later' },
      { ...valid, hidden: { ...hidden, dest: '../x' } },
      { ...valid, hidden: { ...hidden, repeat: 0 } },
      { ...valid, diff: { requireSourceAndTest: true, newTestFailsOnBase: true } },
      { ...valid, diff: { requireSourceAndTest: true, allowedRoots: ['api'] } },
      { ...valid, issue: { title: 'T', body: 'Fix ' + 'M' + '7 first' } },
    ]
    for (const value of broken) expect(scenarioProblems(value).length).toBeGreaterThan(0)
  })

  it('the code-change core scenarios keep their rules', async () => {
    const core = await loadScenarios({})
    expect(core.map(s => s.id)).toEqual(
      expect.arrayContaining(['bug-paging', 'feature-partial-update', 'review-limit-validation']),
    )
    for (const s of core) {
      expect(s.tier).toBe('core')
      expect(scenarioProblems(s)).toEqual([])
      expect(contentProblems('title', s.issue.title)).toEqual([])
      expect(contentProblems('body', s.issue.body)).toEqual([])
      if (s.review) expect(contentProblems('review', s.review.body)).toEqual([])
      expect(s.issue.body.startsWith('@{{agent}} ')).toBe(true)
      expect(s.diff.allowedRoots?.length).toBe(1)
      expect(['api/', 'web/']).toContain(s.diff.allowedRoots?.[0])
      if (['bug-paging', 'feature-partial-update', 'review-limit-validation'].includes(s.id))
        expect(s.diff.allowedRoots).toEqual(['api/'])
      expect(s.diff.allowLockfile).toBe(false)
    }
    expect(byId(core, 'bug-paging').diff.newTestFailsOnBase).toBe(true)
    expect(byId(core, 'review-limit-validation').hidden).toEqual(byId(core, 'bug-paging').hidden)
  })

  it('registry texts render for any target', async () => {
    for (const s of await loadAllScenarios()) {
      const before = scenarioTexts(s)
      for (const t of before) expect(t).not.toMatch(/\bok0\b/)
      const rendered = scenarioTexts(renderScenario(s, EXAMPLE_TARGET))
      expect(scenarioTexts(s)).toEqual(before)
      rendered.forEach((x, i) => {
        expect(x).not.toContain('{{')
        expect(x).not.toMatch(/\bok0\b/)
        expect(contentProblems('text', x)).toEqual([])
        if (before[i]?.includes('@{{agent}}')) expect(x).toContain('@' + EXAMPLE_TARGET.agentLogin)
      })
    }
  })

  it('flows pair the review with the bug issue', async () => {
    const core = await loadScenarios({})
    const flows = scenarioFlows(core)
    expect(flows).toHaveLength(core.filter(s => s.review === undefined).length)
    const bugFlow = flows.find(f => f.initial.id === 'bug-paging')
    expect(bugFlow?.followUps.map(s => s.id)).toEqual(['review-limit-validation'])
    expect(() => scenarioFlows([byId(core, 'review-limit-validation')])).toThrow(/follow-up without an initial/)
    const bug = byId(core, 'bug-paging')
    expect(() => scenarioFlows([bug, { ...bug, id: 'other-bug' }])).toThrow(/several initial/)
  })
})

describe('diff check', () => {
  const SOURCE: DiffFile = {
    filename: 'api/src/services/task-service.ts',
    status: 'modified',
    patch: '@@ -1,1 +1,2 @@\n x\n+  const total = store.count()',
  }
  const TEST: DiffFile = {
    filename: 'api/test/paging.test.ts',
    status: 'added',
    patch: "@@ -0,0 +1,1 @@\n+test('pages every task', () => {})",
  }
  const RULE: DiffRule = { requireSourceAndTest: true, allowedRoots: ['api/'], allowLockfile: false }
  const withTest = (patch: string): DiffFile => ({ ...TEST, patch: '@@ -0,0 +1,1 @@\n+' + patch })
  const check = (files: DiffFile[], rule: DiffRule = RULE, extra: { hiddenDest?: string } = {}) =>
    checkDiff(files, pullPatch(files), rule, extra)
  const expectFail = (
    files: DiffFile[],
    rule: DiffRule,
    pattern: RegExp,
    extra: { hiddenDest?: string } = {},
  ): void => {
    const verdict = check(files, rule, extra)
    expect(verdict.pass).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(pattern)
  }
  const TOUCH = (filename: string): DiffFile => ({ filename, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' })
  const LOCK = TOUCH('package-lock.json')

  it('a source and test change passes', () => {
    expect(check([SOURCE, TEST])).toEqual({ pass: true, reasons: [] })
  })

  it('a skip in a new test fails', () => {
    expectFail([SOURCE, withTest("test.skip('pages every task', () => {})")], RULE, /skip\/only\/todo/)
  })

  it('an only in a new test fails', () => {
    expectFail([SOURCE, withTest("it.only('pages every task', () => {})")], RULE, /skip\/only\/todo/)
  })

  it('a todo option in a new test fails', () => {
    expectFail([SOURCE, withTest("test('x', { todo: true }, () => {})")], RULE, /skip\/only\/todo/)
  })

  it('removing tests without adding them fails', () => {
    const removed: DiffFile = {
      filename: TEST.filename,
      status: 'modified',
      patch: "@@ -1,2 +1,1 @@\n-test('a', () => {})\n-test('b', () => {})\n+test('c', () => {})",
    }
    expectFail([SOURCE, removed], RULE, /test count decreased by 1/)
  })

  it('a CI workflow change fails when allowedRoots is unset', () => {
    expectFail([SOURCE, TEST, TOUCH('.github/workflows/test.yml')], { requireSourceAndTest: true }, /CI workflow/)
  })

  it('a hidden test path change fails', () => {
    const hidden: DiffFile = {
      filename: 'api/test/hidden-acceptance/x.test.ts',
      status: 'added',
      patch: "@@ -0,0 +1,1 @@\n+test('x', () => {})",
    }
    expectFail([SOURCE, TEST, hidden], RULE, /hidden test path/, { hiddenDest: 'api/test/hidden-acceptance' })
  })

  it('a lockfile change fails unless it is allowed', () => {
    expectFail([SOURCE, TEST, LOCK], { requireSourceAndTest: true }, /lockfile/)
    expect(check([SOURCE, TEST, LOCK], { requireSourceAndTest: true, allowLockfile: true })).toEqual({
      pass: true,
      reasons: [],
    })
    expect(check([SOURCE, TEST, LOCK], { ...RULE, allowLockfile: true })).toEqual({ pass: true, reasons: [] })
  })

  it('a change outside the allowed roots fails', () => {
    expectFail([SOURCE, TEST, TOUCH('README.md')], RULE, /outside allowed roots/)
  })

  it('a source only change fails', () => {
    expectFail([SOURCE], RULE, /no-test/)
  })

  it('a test only change fails', () => {
    expectFail([TEST], RULE, /no-source/)
  })

  it('a docs only change fails', () => {
    expectFail([TOUCH('api/README.md')], RULE, /docs-only/)
  })

  it('removing a test file fails', () => {
    const removed: DiffFile = {
      filename: TEST.filename,
      status: 'removed',
      patch: "@@ -1,1 +0,0 @@\n-test('pages every task', () => {})",
    }
    expectFail([SOURCE, removed], RULE, /test file removed/)
  })

  it('patch sections parse a git diff', () => {
    const patch = pullPatch([
      {
        filename: 'api/a.ts',
        status: 'modified',
        patch: '--- a/api/a.ts\n+++ b/api/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new',
      },
      { filename: 'api/b.ts', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-gone\n+here' },
    ])
    const sections = patchSections(patch)
    expect(sections.get('api/a.ts')).toEqual({ added: ['new'], removed: ['old'] })
    expect(sections.get('api/b.ts')).toEqual({ added: ['here'], removed: ['gone'] })
  })
})

describe('hidden acceptance', () => {
  const HIDDEN_TIMEOUT = 180_000

  it(
    'hidden tests fail on the seed and pass with the reference patch',
    async () => {
      const core = await loadScenarios({})
      for (const id of ['bug-paging', 'feature-partial-update']) {
        const s = byId(core, id)
        const onSeed = await runHidden('base', s, { fetchTree: async (_, d) => copySeed(d), install: noInstall })
        expect(onSeed.passed).toBe(false)
        expect(onSeed.runs).toBe(1)
        expect(onSeed.output).toMatch(/fail [1-9]/)
        const onReference = await runHidden('head', s, {
          fetchTree: async (_, d) => copySeed(d, s.id),
          install: noInstall,
        })
        expect(onReference.passed).toBe(true)
        expect(onReference.output).toMatch(/^(# |ℹ )fail 0$/m)
      }
    },
    HIDDEN_TIMEOUT,
  )

  it(
    'the review follow-up reruns the bug hidden tests',
    async () => {
      const core = await loadScenarios({})
      const review = byId(core, 'review-limit-validation')
      const result = await runHidden('head', review, {
        fetchTree: async (_, d) => copySeed(d, 'bug-paging'),
        install: noInstall,
      })
      expect(result.passed).toBe(true)
    },
    HIDDEN_TIMEOUT,
  )

  it(
    'reference overlays with hidden tests typecheck',
    async () => {
      const all = await loadAllScenarios()
      for (const id of readdirSync(REFERENCE)) {
        const s = byId(all, id)
        if (!s.hidden) throw new Error('reference without hidden tests: ' + id)
        if (s.hidden?.workspace !== 'api') continue
        const d = tmp()
        copySeed(d, id)
        cpSync(join(FIXTURES_DIR, s.hidden.dir), join(d, s.hidden.dest), { recursive: true })
        symlinkSync(join(ROOT, 'node_modules'), join(d, 'node_modules'), 'dir')
        const res = spawnSync(
          process.execPath,
          [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(d, 'api/tsconfig.json'), '--noEmit'],
          { encoding: 'utf8' },
        )
        expect(res.status, res.stdout + res.stderr).toBe(0)
      }
    },
    HIDDEN_TIMEOUT,
  )

  it(
    'hidden files stay out of the playground',
    async () => {
      const all = await loadAllScenarios()
      for (const s of all) {
        if (!s.hidden) continue
        const dir = resolve(FIXTURES_DIR, s.hidden.dir)
        expect(existsSync(dir)).toBe(true)
        expect(dir.startsWith(SEED_DIR + sep)).toBe(false)
      }
      expect(REFERENCE.startsWith(SEED_DIR + sep)).toBe(false)
      expect(join(FIXTURES_DIR, 'playground-prepared').startsWith(SEED_DIR + sep)).toBe(false)
      const files = loadSeed(true)
      const dests = all.flatMap(s => (s.hidden ? [s.hidden.dest] : []))
      for (const f of files) {
        for (const dest of dests) expect(f.path === dest || f.path.startsWith(dest + '/')).toBe(false)
        expect(f.path.includes('playground-hidden')).toBe(false)
        expect(f.path.includes('playground-reference')).toBe(false)
        expect(f.path.includes('playground-prepared')).toBe(false)
      }
    },
    HIDDEN_TIMEOUT,
  )

  it(
    'every run of the matrix runs',
    async () => {
      const log = join(tmp(), 'log.txt')
      const command = [
        'node',
        '-e',
        "process.getBuiltinModule('node:fs').appendFileSync(" + JSON.stringify(log) + ", process.env.K + '\\n')",
      ]
      const scenario = probe(command, { envMatrix: [{ K: '1' }, { K: '2' }, { K: '3' }], repeat: 3 })
      const result = await runHidden('head', scenario, {
        fetchTree: fetchApi,
        install: noInstall,
        fixturesDir: fixtures(),
      })
      expect(result.runs).toBe(9)
      expect(result.passed).toBe(true)
      const lines = readFileSync(log, 'utf8')
        .split('\n')
        .filter(l => l !== '')
        .sort()
      expect(lines).toEqual(['1', '1', '1', '2', '2', '2', '3', '3', '3'])
    },
    HIDDEN_TIMEOUT,
  )

  it(
    'one failing run fails the result',
    async () => {
      const command = ['node', '-e', "process.exit(process.env.K === '2' ? 1 : 0)"]
      const scenario = probe(command, { envMatrix: [{ K: '1' }, { K: '2' }, { K: '3' }], repeat: 3 })
      const result = await runHidden('head', scenario, {
        fetchTree: fetchApi,
        install: noInstall,
        fixturesDir: fixtures(),
      })
      expect(result.runs).toBe(9)
      expect(result.passed).toBe(false)
    },
    HIDDEN_TIMEOUT,
  )

  it(
    'the time limit fails the result',
    async () => {
      const scenario = probe(['node', '-e', 'setTimeout(() => {}, 20000)'])
      const result = await runHidden('head', scenario, {
        fetchTree: fetchApi,
        install: noInstall,
        fixturesDir: fixtures(),
        timeoutMs: 1500,
      })
      expect(result.passed).toBe(false)
      expect(result.output).toMatch(/timed out/)
    },
    HIDDEN_TIMEOUT,
  )

  it(
    'host credentials are not passed',
    async () => {
      vi.stubEnv('GH_TOKEN', 'gh-secret-value')
      vi.stubEnv('ISSUECREW_GITHUB_TOKEN', 'agent-secret-value')
      const scenario = probe(['node', '-e', 'console.log(JSON.stringify(process.env))'])
      const result = await runHidden('head', scenario, {
        fetchTree: fetchApi,
        install: noInstall,
        fixturesDir: fixtures(),
      })
      expect(result.runs).toBe(1)
      expect(result.output).not.toContain('gh-secret-value')
      expect(result.output).not.toContain('agent-secret-value')
      expect(result.output).not.toContain('"HOME":"' + homedir() + '"')
      expect(result.output).toContain('"PATH"')
    },
    HIDDEN_TIMEOUT,
  )

  it(
    'an install failure fails without running',
    async () => {
      const core = await loadScenarios({})
      const result = await runHidden('head', byId(core, 'bug-paging'), {
        fetchTree: fetchApi,
        install: async () => ({ code: 1, output: 'boom' }),
      })
      expect(result.passed).toBe(false)
      expect(result.runs).toBe(0)
    },
    HIDDEN_TIMEOUT,
  )
})

describe('base failure', () => {
  const BASE_TIMEOUT = 120_000

  it(
    'a new test that already passes on the base does not count',
    async () => {
      const base = seedCopy()
      const head = seedCopy()
      writeFileSync(join(head, 'api/test/extra.test.ts'), CURSOR_TEST)
      const result = await testsFailOnBase({ base, head, testFiles: ['api/test/extra.test.ts'], cwd: 'api' })
      expect(result.passed).toBe(false)
      expect(result.reason).toBe('new-test-passes-on-base')
      expect(result.pristineCode).toBe(0)
    },
    BASE_TIMEOUT,
  )

  it(
    'a new test that fails on the base counts',
    async () => {
      const base = seedCopy()
      const head = seedCopy()
      writeFileSync(join(head, 'api/test/extra.test.ts'), PAGING_TEST)
      const result = await testsFailOnBase({ base, head, testFiles: ['api/test/extra.test.ts'], cwd: 'api' })
      expect(result.passed).toBe(true)
    },
    BASE_TIMEOUT,
  )

  it(
    'no new test does not count',
    async () => {
      const base = seedCopy()
      const head = seedCopy()
      const result = await testsFailOnBase({ base, head, testFiles: [], cwd: 'api' })
      expect(result.passed).toBe(false)
      expect(result.reason).toBe('no-new-test')
    },
    BASE_TIMEOUT,
  )
})

describe('scenario verdict', () => {
  it('all four parts are required for the bug scenario', async () => {
    const bug = byId(await loadScenarios({}), 'bug-paging')
    for (const checks of ['success', 'failure']) {
      for (const hidden of [true, false]) {
        for (const diff of [true, false]) {
          for (const base of [true, false]) {
            const failed = [
              checks !== 'success' ? 'checks' : null,
              hidden ? null : 'hidden',
              diff ? null : 'diff',
              base ? null : 'base-failure',
            ].filter(Boolean)
            const result = judgeScenario(bug, {
              checks,
              hidden: { passed: hidden },
              diff: { pass: diff },
              base: { passed: base },
            })
            expect(result).toEqual({ passed: failed.length === 0, failed })
          }
        }
      }
    }
  })

  it('other scenarios do not need a base failure', async () => {
    const feature = byId(await loadScenarios({}), 'feature-partial-update')
    expect(
      judgeScenario(feature, { checks: 'success', hidden: { passed: true }, diff: { pass: true }, base: null }),
    ).toEqual({ passed: true, failed: [] })
    expect(judgeScenario(feature, { checks: 'success', hidden: null, diff: { pass: true }, base: null })).toEqual({
      passed: false,
      failed: ['hidden'],
    })
    expect(
      judgeScenario(feature, { checks: 'pending', hidden: { passed: true }, diff: { pass: true }, base: null }),
    ).toEqual({ passed: false, failed: ['checks'] })
  })

  it('the live spec uses the registry and the combined verdict', () => {
    const text = readFileSync(join(ROOT, 'tests/live/code-change.spec.ts'), 'utf8')
    for (const needle of [
      'loadScenarios(process.env)',
      'scenarioFlows(',
      'judgeScenario(',
      'runHidden(',
      'checkDiff(',
      'testsFailOnBase(',
      "/pulls/' + n + '/files",
    ]) {
      expect(text).toContain(needle)
    }
    for (const gone of ['BUG_BODY', 'FEATURE_BODY', 'REVIEW_BODY', 'Paging through tasks drops']) {
      expect(text).not.toContain(gone)
    }
  })
})
