import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LIVE_LIMITS, LIVE_WAIT, pullWaitMs } from './live/code-change-config.ts'
import { runLocalCi } from './live/hidden.ts'
import { checkDiff, pullPatch } from './live/rules.ts'
import type { DiffFile, DiffRule } from './live/rules.ts'
import { judgeScenario, loadAllScenarios, loadScenarios, scenarioProblems } from './live/scenarios.ts'
import type { LiveScenario } from './live/scenarios.ts'

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'live-shared-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const scenarioSource = (id: string, tier: string): string =>
  "export const scenario = { id: '" + id + "', tier: '" + tier + "', issue: { title: 'T " + id + "', body: 'B " + id + "' }, diff: { requireSourceAndTest: true } }\n"

const TOUCH = (filename: string): DiffFile => ({ filename, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' })

describe('shared live harness', () => {
  it('requireSource needs a non-test source or stylesheet change', () => {
    const rule: DiffRule = { requireSourceAndTest: false, allowedRoots: ['web/'], requireSource: true }
    const check = (files: DiffFile[], r: DiffRule = rule) => checkDiff(files, pullPatch(files), r)

    const docs = check([TOUCH('web/README.md')])
    expect(docs.pass).toBe(false)
    expect(docs.reasons).toEqual(['no source change'])

    expect(check([TOUCH('web/src/styles.css')])).toEqual({ pass: true, reasons: [] })
    expect(check([TOUCH('web/src/components/TaskRow.tsx')])).toEqual({ pass: true, reasons: [] })

    const testOnly = check([TOUCH('web/src/components/TaskRow.test.tsx')])
    expect(testOnly.pass).toBe(false)
    expect(testOnly.reasons).toContain('no source change')

    expect(check([TOUCH('web/README.md')], { requireSourceAndTest: false, allowedRoots: ['web/'] })).toEqual({ pass: true, reasons: [] })
  })

  it('scenario validation covers answer, prepare and requireSource', () => {
    const base = { id: 'x', tier: 'core', issue: { title: 'T', body: 'B' }, diff: { requireSourceAndTest: false } }
    expect(scenarioProblems(base)).toEqual([])
    const broken: unknown[] = [
      { ...base, answer: '' },
      { ...base, answer: 'see M' + '7' },
      { ...base, diff: { requireSourceAndTest: false, requireSource: 'yes' } },
      { ...base, prepare: { path: 'web/x.ts', fixture: 'a', commitMessage: 'test: x', comment: 'c' } },
      { ...base, prepare: { path: 'api/test/a.test.ts', fixture: 'a', commitMessage: 'oops', comment: 'c' } },
    ]
    for (const value of broken) expect(scenarioProblems(value).length).toBeGreaterThan(0)
    const valid = { ...base, prepare: { path: 'api/test/a.test.ts', fixture: 'playground-prepared/x/a.test.ts', commitMessage: 'test: add a test', comment: '@example-agent c' } }
    expect(scenarioProblems(valid)).toEqual([])
  })

  it('ambiguity and prepared parts join the verdict only when declared', () => {
    const base: LiveScenario = { id: 'x', tier: 'core', issue: { title: 'T', body: 'B' }, diff: { requireSourceAndTest: false } }
    const input = { checks: 'success', hidden: null, diff: { pass: true }, base: null }
    expect(judgeScenario(base, input)).toEqual({ passed: true, failed: [] })
    const ambiguous: LiveScenario = { ...base, ambiguity: 'clarify-or-state' }
    expect(judgeScenario(ambiguous, { ...input, ambiguity: { passed: false } })).toEqual({ passed: false, failed: ['ambiguity'] })
    expect(judgeScenario(ambiguous, input)).toEqual({ passed: false, failed: ['ambiguity'] })
    const prepared: LiveScenario = { ...base, prepare: { path: 'api/test/a.test.ts', fixture: 'playground-prepared/x/a.test.ts', commitMessage: 'test: add a test', comment: '@example-agent c' } }
    expect(judgeScenario(prepared, { ...input, prepared: { passed: false } })).toEqual({ passed: false, failed: ['prepared'] })
    expect(judgeScenario(prepared, { ...input, prepared: { passed: true } })).toEqual({ passed: true, failed: [] })
  })

  it('loadAllScenarios returns extended scenarios without selection', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'alpha.ts'), scenarioSource('alpha', 'core'))
    writeFileSync(join(dir, 'ext-one.ts'), scenarioSource('ext-one', 'extended'))
    expect((await loadAllScenarios(dir)).map(s => s.id)).toEqual(['alpha', 'ext-one'])
    expect((await loadScenarios({}, dir)).map(s => s.id)).toEqual(['alpha'])
  })

  it('local CI runs install, typecheck and test in order', async () => {
    const root = tmp()
    const write = (typecheck: number, test: number): void => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(' + typecheck + ')"', test: 'node -e "process.exit(' + test + ')"' } }))
    }
    write(0, 3)
    expect(await runLocalCi(root, { install: async () => ({ code: 0, output: '' }) })).toMatchObject({ code: 3, step: 'test' })
    write(2, 0)
    expect(await runLocalCi(root, { install: async () => ({ code: 0, output: '' }) })).toMatchObject({ code: 2, step: 'typecheck' })
    write(0, 0)
    expect(await runLocalCi(root, { install: async () => ({ code: 1, output: '' }) })).toMatchObject({ code: 1, step: 'install' })
    expect(await runLocalCi(root, { install: async () => ({ code: 0, output: '' }) })).toMatchObject({ code: 0, step: 'done' })
  }, 180_000)

  it('pull wait scales with flows', () => {
    expect(pullWaitMs(1)).toBe(LIVE_WAIT.pullPerRoundMs)
    expect(pullWaitMs(4)).toBe(2 * LIVE_WAIT.pullPerRoundMs)
    expect(pullWaitMs(7)).toBe(4 * LIVE_WAIT.pullPerRoundMs)
    expect(LIVE_LIMITS.maxTurns).toBeGreaterThanOrEqual(200)
    expect(LIVE_LIMITS.maxBudgetUsd).toBeGreaterThanOrEqual(20)
  })
})
