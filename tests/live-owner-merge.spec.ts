import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult, Runner } from './live/gh.ts'
import { assertApiTarget } from './live/guard.ts'
import { flowCandidates, mergeOwnerPulls, pickMerges, squashTitle, type MergeCandidate, type MergeVerdict } from './live/owner-merge.ts'
import { commitProblems, harnessMergesOnly, seedCommitIndex, SEED_MESSAGES } from './live/rules.ts'
import { loadAllScenarios, scenarioProblems, type LiveScenario, type ScenarioFlow, type ScenarioKind } from './live/scenarios.ts'
import { clearLiveTarget, EXAMPLE_TARGET, stubLiveTarget } from './fixtures/live-target.ts'

beforeEach(() => stubLiveTarget())
afterEach(() => vi.unstubAllEnvs())

const P = EXAMPLE_TARGET.repo
const EP = 'repos/' + P + '/pulls/7'

interface Call { endpoint: string; method: string; input?: string; env: Readonly<Record<string, string>> }

function result(body: unknown): RunResult {
  return { code: 0, stdout: Buffer.from(JSON.stringify(body)), stderr: '' }
}

function failure(stderr: string): RunResult {
  return { code: 1, stdout: Buffer.alloc(0), stderr }
}

function fakeRun(table: Record<string, RunResult>): { run: Runner; calls: Call[] } {
  const calls: Call[] = []
  const run: Runner = async (args, env, input) => {
    const index = args.findIndex(arg => arg === '-X' || arg === '--method')
    const method = index >= 0 ? (args[index + 1] ?? '').toUpperCase() : 'GET'
    const endpoint = args[1] ?? ''
    calls.push({ endpoint, method, input, env })
    return table[method + ' ' + endpoint] ?? failure('unexpected call: ' + method + ' ' + endpoint)
  }
  return { run, calls }
}

async function loaded(): Promise<LiveScenario[]> {
  return loadAllScenarios()
}

function byId(scenarios: LiveScenario[], id: string): LiveScenario {
  const found = scenarios.find(s => s.id === id)
  if (!found) throw new Error('missing scenario ' + id)
  return found
}

function candidate(base: LiveScenario, id: string, kind: ScenarioKind | undefined, pull: number, head: string, passed: boolean): MergeCandidate {
  return { scenario: { ...base, id, kind }, pull, head, passed }
}

describe('owner merge', () => {
  it('core scenarios carry their kind', async () => {
    const scenarios = await loadAllScenarios()
    const kinds: Record<string, ScenarioKind> = { 'bug-paging': 'bug', 'feature-partial-update': 'feature', 'ui-overdue-rows': 'ui', 'ui-polish-list': 'ui' }
    for (const s of scenarios) {
      expect(s.kind, s.id).toBe(kinds[s.id])
    }
    const bugPaging = byId(scenarios, 'bug-paging')
    expect(scenarioProblems({ ...bugPaging, kind: 'chore' })).toContain('kind must be bug, feature or ui')
    expect(scenarioProblems(bugPaging)).toEqual([])
  })

  it('flowCandidates combines the review follow-up', async () => {
    const bug = byId(await loaded(), 'bug-paging')
    const review: LiveScenario = { ...bug, id: 'bug-paging-review', review: { body: 'please also cover the last page' } }
    const flows: ScenarioFlow[] = [{ initial: bug, followUps: [review] }]
    const passing: MergeVerdict[] = [
      { id: 'bug-paging', pr: 1, head: 'h1', verdict: { passed: true } },
      { id: 'bug-paging-review', pr: 1, head: 'h2', verdict: { passed: true } },
    ]
    expect(flowCandidates(flows, passing)).toMatchObject([{ pull: 1, head: 'h2', passed: true }])
    const failing = passing.map(v => (v.id === 'bug-paging-review' ? { ...v, verdict: { passed: false } } : v))
    expect(flowCandidates(flows, failing)).toMatchObject([{ pull: 1, passed: false }])
    const missing = passing.filter(v => v.id !== 'bug-paging-review')
    expect(flowCandidates(flows, missing)).toMatchObject([{ pull: 1, passed: false }])
  })

  it('pickMerges picks the first passing flow per kind in bug, feature, ui order', async () => {
    const bug = byId(await loaded(), 'bug-paging')
    const candidates: MergeCandidate[] = [
      candidate(bug, 'ui-a', 'ui', 1, 'hA', true),
      candidate(bug, 'bug-a', 'bug', 2, 'hBa', false),
      candidate(bug, 'bug-b', 'bug', 3, 'hB', true),
      candidate(bug, 'ui-b', 'ui', 4, 'hUB', true),
      candidate(bug, 'no-kind', undefined, 5, 'hN', true),
    ]
    expect(pickMerges(candidates)).toEqual([
      { kind: 'bug', pull: 3, head: 'hB' },
      { kind: 'ui', pull: 1, head: 'hA' },
    ])
  })

  it('pickMerges skips a flow whose follow-up failed', async () => {
    const scenarios = await loadAllScenarios()
    const bug = byId(scenarios, 'bug-paging')
    const second: LiveScenario = { ...bug, id: 'bug-second', issue: { ...bug.issue, title: 'Second paging report' } }
    const review: LiveScenario = { ...bug, id: 'bug-paging-review', review: { body: 'please also cover the last page' } }
    const flows: ScenarioFlow[] = [{ initial: bug, followUps: [review] }, { initial: second, followUps: [] }]
    const verdicts: MergeVerdict[] = [
      { id: 'bug-paging', pr: 1, head: 'h1', verdict: { passed: true } },
      { id: 'bug-paging-review', pr: 1, head: 'h2', verdict: { passed: false } },
      { id: 'bug-second', pr: 2, head: 'h3', verdict: { passed: true } },
    ]
    expect(pickMerges(flowCandidates(flows, verdicts))).toEqual([{ kind: 'bug', pull: 2, head: 'h3' }])
  })

  it('mergeOwnerPulls squash-merges with the judged head and deletes the agent branch', async () => {
    const { run, calls } = fakeRun({
      ['GET ' + EP]: result({ title: 'Paging through tasks drops the last one', head: { ref: 'agent/fix-paging', sha: 'abc' } }),
      ['PUT ' + EP + '/merge']: result({ sha: 'merged-1', merged: true }),
      ['DELETE repos/' + P + '/git/refs/heads/agent/fix-paging']: { code: 0, stdout: Buffer.alloc(0), stderr: '' },
    })
    const records = await mergeOwnerPulls([{ kind: 'bug', pull: 7, head: 'abc' }], { token: 'owner-token', run })
    expect(calls.map(c => c.method + ' ' + c.endpoint)).toEqual([
      'GET repos/' + P + '/pulls/7',
      'PUT repos/' + P + '/pulls/7/merge',
      'DELETE repos/' + P + '/git/refs/heads/agent/fix-paging',
    ])
    expect(JSON.parse(calls[1]!.input!)).toEqual({ merge_method: 'squash', sha: 'abc', commit_title: 'fix: paging through tasks drops the last one (#7)', commit_message: '' })
    expect(commitProblems(JSON.parse(calls[1]!.input!).commit_title)).toEqual([])
    for (const call of calls) expect(call.env.GH_TOKEN).toBe('owner-token')
    expect(records).toEqual([{ kind: 'bug', pull: 7, sha: 'merged-1', merged: true }])
  })

  it('405 and 409 are skipped and recorded', async () => {
    const { run, calls } = fakeRun({
      ['GET ' + EP]: result({ title: 'fix: one', head: { ref: 'agent/one', sha: 'abc' } }),
      ['PUT ' + EP + '/merge']: failure('gh: Pull Request is not mergeable (HTTP 405)'),
      ['GET repos/' + P + '/pulls/8']: result({ title: 'fix: two', head: { ref: 'agent/two', sha: 'def' } }),
      ['PUT repos/' + P + '/pulls/8/merge']: failure('gh: head changed (HTTP 409)'),
    })
    const records = await mergeOwnerPulls([{ kind: 'bug', pull: 7, head: 'abc' }, { kind: 'feature', pull: 8, head: 'def' }], { token: 'owner-token', run })
    expect(records.map(r => r.merged)).toEqual([false, false])
    expect(records[0]!.reason).toContain('405')
    expect(records[1]!.reason).toContain('409')
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
  })

  it('a later pick still merges after a conflict', async () => {
    const { run } = fakeRun({
      ['GET ' + EP]: result({ title: 'fix: one', head: { ref: 'agent/one', sha: 'abc' } }),
      ['PUT ' + EP + '/merge']: failure('gh: head changed (HTTP 409)'),
      ['GET repos/' + P + '/pulls/8']: result({ title: 'feat: two', head: { ref: 'agent/two', sha: 'def' } }),
      ['PUT repos/' + P + '/pulls/8/merge']: result({ sha: 'merged-2', merged: true }),
      ['DELETE repos/' + P + '/git/refs/heads/agent/two']: { code: 0, stdout: Buffer.alloc(0), stderr: '' },
    })
    const records = await mergeOwnerPulls([{ kind: 'bug', pull: 7, head: 'abc' }, { kind: 'feature', pull: 8, head: 'def' }], { token: 'owner-token', run })
    expect(records.map(r => r.merged)).toEqual([false, true])
  })

  it('a title with a ' + 'mile' + 'stone reference is refused before the merge', async () => {
    const { run, calls } = fakeRun({
      ['GET ' + EP]: result({ title: 'fix: paging ' + 'M' + '12', head: { ref: 'agent/fix-paging', sha: 'abc' } }),
    })
    const records = await mergeOwnerPulls([{ kind: 'bug', pull: 7, head: 'abc' }], { token: 'owner-token', run })
    expect(calls.some(c => c.method === 'PUT')).toBe(false)
    expect(records[0]!.merged).toBe(false)
    expect(records[0]!.reason?.startsWith('title:')).toBe(true)
  })

  it('squashTitle writes a Conventional Commits title per kind', () => {
    const rows: [ScenarioKind, string, number, string][] = [
      ['bug', 'Paging through tasks drops the last one', 21, 'fix: paging through tasks drops the last one (#21)'],
      ['feature', 'Add partial updates for tasks', 23, 'feat: add partial updates for tasks (#23)'],
      ['ui', 'Overdue tasks are hard to spot in the task list', 22, 'feat: overdue tasks are hard to spot in the task list (#22)'],
      ['ui', 'task 목록 화면을 좀 더 보기 좋게 해 주세요', 24, 'feat: task 목록 화면을 좀 더 보기 좋게 해 주세요 (#24)'],
      ['bug', 'fix(api): Correct the cursor.', 5, 'fix: correct the cursor (#5)'],
      ['feature', 'Support PATCH /tasks/:id (#9)', 9, 'feat: support PATCH /tasks/:id (#9)'],
      ['bug', '  ', 3, 'fix: apply the pull request change (#3)'],
    ]
    for (const [kind, title, pull, expected] of rows) {
      const result = squashTitle(kind, title, pull)
      expect(result).toBe(expected)
      expect(commitProblems(result)).toEqual([])
    }
  })

  it('squashTitle keeps a ' + 'mile' + 'stone reference so the merge refuses it', () => {
    expect(commitProblems(squashTitle('bug', 'Paging ' + 'M' + '12', 1)).length).toBeGreaterThan(0)
  })

  it('owner squash merges are recognised by the seed reset check', () => {
    const commits = [
      { sha: 'm1', commit: { message: squashTitle('bug', 'Paging through tasks drops the last one', 21) } },
      { sha: 's0', commit: { message: SEED_MESSAGES.workflowUpdate } },
    ]
    const pulls = new Map([['m1', [{ number: 21, merged_at: 't', merge_commit_sha: 'm1', head: { ref: 'agent/x' }, user: { login: EXAMPLE_TARGET.agentLogin }, merged_by: { login: EXAMPLE_TARGET.ownerLogin } }]]])
    expect(harnessMergesOnly(commits, pulls, { agentLogin: EXAMPLE_TARGET.agentLogin, ownerLogin: EXAMPLE_TARGET.ownerLogin })).toBe(true)
    expect(seedCommitIndex(commits)).toBe(1)
  })

  it('an unexpected status is recorded as an error', async () => {
    const { run } = fakeRun({
      ['GET ' + EP]: result({ title: 'fix: one', head: { ref: 'agent/one', sha: 'abc' } }),
      ['PUT ' + EP + '/merge']: failure('gh: Server Error (HTTP 500)'),
    })
    const records = await mergeOwnerPulls([{ kind: 'bug', pull: 7, head: 'abc' }], { token: 'owner-token', run })
    expect(records[0]!.merged).toBe(false)
    expect(records[0]!.reason?.startsWith('error:')).toBe(true)
  })

  it('merge refuses without a live target', async () => {
    clearLiveTarget()
    const { run, calls } = fakeRun({})
    await expect(mergeOwnerPulls([{ kind: 'bug', pull: 1, head: 'h' }], { token: 't', run })).rejects.toThrow(/live target not configured/)
    expect(calls).toHaveLength(0)
  })
})

function queuedRun(queues: Record<string, RunResult[]>): { run: Runner; calls: Call[] } {
  const calls: Call[] = []
  const run: Runner = async (args, env, input) => {
    const index = args.findIndex(arg => arg === '-X' || arg === '--method')
    const method = index >= 0 ? (args[index + 1] ?? '').toUpperCase() : 'GET'
    const endpoint = args[1] ?? ''
    calls.push({ endpoint, method, input, env })
    const queue = queues[method + ' ' + endpoint]
    if (!queue || queue.length === 0) return failure('unexpected call: ' + method + ' ' + endpoint)
    return queue.length > 1 ? queue.shift()! : queue[0]!
  }
  return { run, calls }
}

describe('owner merge mergeable settling and 405 retry', () => {
  const GET_KEY = 'GET ' + EP
  const PUT_KEY = 'PUT ' + EP + '/merge'
  const DEL_KEY = 'DELETE repos/' + P + '/git/refs/heads/agent/one'
  const pick = [{ kind: 'bug' as const, pull: 7, head: 'abc' }]
  const merged: RunResult = { code: 0, stdout: Buffer.from(JSON.stringify({ sha: 'merged-1', merged: true })), stderr: '' }
  const deleted: RunResult = { code: 0, stdout: Buffer.alloc(0), stderr: '' }
  const pullBody = (mergeable: boolean | null, extra: Record<string, unknown> = {}): RunResult => result({ title: 'fix: one', head: { ref: 'agent/one', sha: 'abc' }, mergeable, ...extra })

  it('polls a null mergeable until GitHub settles it, then merges', async () => {
    const { run, calls } = queuedRun({ [GET_KEY]: [pullBody(null), pullBody(null), pullBody(true)], [PUT_KEY]: [merged], [DEL_KEY]: [deleted] })
    const delays: number[] = []
    const records = await mergeOwnerPulls(pick, { token: 'owner-token', run, sleep: async ms => { delays.push(ms) } })
    expect(calls.filter(c => c.method === 'GET')).toHaveLength(3)
    expect(delays).toEqual([3000, 3000])
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1)
    expect(records[0]).toMatchObject({ merged: true, sha: 'merged-1', attempts: { polls: 3 } })
  })

  it('bounds the poll and still attempts the merge when mergeable stays unknown', async () => {
    const { run, calls } = queuedRun({ [GET_KEY]: [pullBody(null)], [PUT_KEY]: [merged], [DEL_KEY]: [deleted] })
    const delays: number[] = []
    const records = await mergeOwnerPulls(pick, { token: 'owner-token', run, sleep: async ms => { delays.push(ms) } })
    expect(calls.filter(c => c.method === 'GET')).toHaveLength(10)
    expect(delays).toHaveLength(9)
    expect(delays.every(ms => ms === 3000)).toBe(true)
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1)
    expect(records[0]).toMatchObject({ merged: true, attempts: { polls: 10 } })
  })

  // Reconstructed: the live 405 text was not captured in the raw record; GitHub's standard wording is used.
  it('retries a 405 once after re-polling and merges', async () => {
    const { run, calls } = queuedRun({ [GET_KEY]: [pullBody(true)], [PUT_KEY]: [failure('gh: Pull Request is not mergeable (HTTP 405)'), merged], [DEL_KEY]: [deleted] })
    const records = await mergeOwnerPulls(pick, { token: 'owner-token', run, sleep: async () => {} })
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(2)
    expect(records[0]).toMatchObject({ merged: true, attempts: { putCalls: 2 } })
    expect(records[0]!.attempts!.message405).toContain('405')
    expect(calls.some(c => c.method === 'DELETE')).toBe(true)
  })

  it('a second 405 is recorded and never retried a third time', async () => {
    const { run, calls } = queuedRun({
      [GET_KEY]: [pullBody(true)],
      [PUT_KEY]: [failure('gh: Pull Request is not mergeable (HTTP 405) first'), failure('gh: Pull Request is not mergeable (HTTP 405) second')],
    })
    const records = await mergeOwnerPulls(pick, { token: 'owner-token', run, sleep: async () => {} })
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(2)
    expect(records[0]!.merged).toBe(false)
    expect(records[0]!.reason).toContain('405')
    expect(records[0]!.reason).toContain('first')
    expect(records[0]!.reason).toContain('second')
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
  })

  it('mergeable false is recorded without a PUT', async () => {
    const { run, calls } = queuedRun({ [GET_KEY]: [pullBody(false, { mergeable_state: 'dirty' })], [PUT_KEY]: [merged], [DEL_KEY]: [deleted] })
    const records = await mergeOwnerPulls(pick, { token: 'owner-token', run, sleep: async () => {} })
    expect(calls.some(c => c.method === 'PUT')).toBe(false)
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
    expect(records[0]!.merged).toBe(false)
    expect(records[0]!.reason).toContain('mergeable=false')
  })
})

describe('guard merge endpoint', () => {
  const allowed: string[][] = [
    ['repos/' + P + '/pulls/7/merge', '-X', 'PUT', '--input', '-'],
    ['repos/' + P + '/pulls/7/merge', '--method', 'PUT'],
    ['repos/' + P + '/pulls/7/merge'],
    ['repos/' + P + '/pulls/7', '-X', 'PATCH', '-f', 'state=closed'],
    ['repos/' + P + '/pulls', '-X', 'POST'],
    ['repos/' + P + '/issues', '-X', 'POST'],
    ['repos/' + P + '/pulls/7/merge', '-X', 'put'],
  ]
  for (const args of allowed) {
    it('allows ' + args.join(' '), () => {
      expect(() => assertApiTarget(args)).not.toThrow()
    })
  }

  const rejected: string[][] = [
    ['repos/example/main/pulls/7/merge', '-X', 'PUT'],
    ['repos/other/x/pulls/7/merge', '-X', 'PUT'],
    ['repos/example/playground-archived/pulls/7/merge', '-X', 'PUT'],
    ['repos/example/playground-readonly/pulls/7/merge', '-X', 'PUT'],
    ['repos/' + P + '/pulls/7/update-branch', '-X', 'PUT'],
    ['repos/' + P + '/pulls/7/reviews/1', '-X', 'PUT'],
    ['repos/' + P + '/pulls/x/merge', '-X', 'PUT'],
    ['repos/' + P + '/pulls/7/merge/x', '-X', 'PUT'],
    ['repos/example/main/pulls/7/merge', '--method=PUT'],
    ['repos/' + P + '/pulls/7/update-branch', '-X', 'put'],
  ]
  for (const args of rejected) {
    it('rejects ' + args.join(' '), () => {
      expect(() => assertApiTarget(args)).toThrow()
    })
  }
})

describe('live spec order', () => {
  const spec = readFileSync(join(import.meta.dirname, 'live', 'code-change.spec.ts'), 'utf8')

  it('merges after judging and before evidence cleanup', () => {
    const afterAll = spec.indexOf('afterAll(async')
    const merge = spec.indexOf('mergeOwnerPulls(pickMerges(flowCandidates(FLOWS')
    const cleanup = spec.indexOf('evidence.cleanup = await cleanup()')
    expect(afterAll).toBeGreaterThan(-1)
    expect(afterAll).toBeLessThan(merge)
    expect(merge).toBeLessThan(cleanup)
    expect(spec).toContain('evidence.merges = merges')
    expect(spec).toContain('if (merged.has(pull.number)) continue')
  })
})
