import { ghJson, ghRaw, type Runner } from './gh.ts'
import { assertAllowedRepo } from './guard.ts'
import { AGENT_BRANCH, commitProblems } from './rules.ts'
import type { LiveScenario, ScenarioFlow, ScenarioKind } from './scenarios.ts'
import { SCENARIO_KINDS } from './scenarios.ts'
import { requireLiveTarget } from './target.ts'

export interface MergeVerdict { id: string; pr: number; head: string; verdict: { passed: boolean } }
export interface MergeCandidate { scenario: LiveScenario; pull: number; head: string; passed: boolean }
export interface MergePick { kind: ScenarioKind; pull: number; head: string }
export interface MergeAttempts { polls: number; putCalls: number; message405?: string }
export interface MergeRecord { kind: ScenarioKind; pull: number; sha: string; merged: boolean; reason?: string; attempts?: MergeAttempts }
export interface MergeDeps { sleep?: (ms: number) => Promise<void>; pollAttempts?: number; pollMs?: number }

interface PullState { title: string; head: { ref: string; sha: string }; mergeable?: boolean | null; mergeable_state?: string }

export const SQUASH_TYPES: Readonly<Record<ScenarioKind, 'fix' | 'feat'>> = { bug: 'fix', feature: 'feat', ui: 'feat' }

export function squashTitle(kind: ScenarioKind, prTitle: string, pull: number): string {
  let s = prTitle.replace(/\s+/g, ' ').trim()
  s = s.replace(/^[a-z]+(\([^()]*\))?!?:\s*/i, '')
  s = s.replace(/\s*\(#\d+\)$/, '')
  s = s.replace(/\.+$/, '').trim()
  s = s.charAt(0).toLowerCase() + s.slice(1)
  if (s === '') s = 'apply the pull request change'
  return SQUASH_TYPES[kind] + ': ' + s + ' (#' + pull + ')'
}

export function flowCandidates(flows: readonly ScenarioFlow[], verdicts: readonly MergeVerdict[]): MergeCandidate[] {
  const last = (id: string): MergeVerdict | undefined => [...verdicts].reverse().find(v => v.id === id)
  const candidates: MergeCandidate[] = []
  for (const flow of flows) {
    const initial = last(flow.initial.id)
    if (!initial) continue
    const follow = flow.followUps.map(f => last(f.id))
    const passed = initial.verdict.passed && follow.every(v => v?.verdict.passed === true)
    const tail = follow[follow.length - 1]
    const head = flow.followUps.length > 0 && tail ? tail.head : initial.head
    candidates.push({ scenario: flow.initial, pull: initial.pr, head, passed })
  }
  return candidates
}

export function pickMerges(flows: readonly MergeCandidate[]): MergePick[] {
  const picks: MergePick[] = []
  for (const kind of SCENARIO_KINDS) {
    const hit = flows.find(f => f.scenario.kind === kind && f.passed)
    if (hit) picks.push({ kind, pull: hit.pull, head: hit.head })
  }
  return picks
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

export async function mergeOwnerPulls(picks: readonly MergePick[], o: { token: string; run?: Runner } & MergeDeps): Promise<MergeRecord[]> {
  const REPO = assertAllowedRepo(requireLiveTarget().repo)
  const sleep = o.sleep ?? defaultSleep
  const pollAttempts = o.pollAttempts ?? 10
  const pollMs = o.pollMs ?? 3000
  const records: MergeRecord[] = []
  for (const pick of picks) {
    const endpoint = 'repos/' + REPO + '/pulls/' + pick.pull
    let polls = 0
    let putCalls = 0
    let message405: string | undefined
    const get = async (): Promise<PullState> => {
      polls++
      return ghJson<PullState>(o.token, [endpoint], { run: o.run })
    }
    const settle = async (): Promise<PullState> => {
      let pull = await get()
      for (let i = 1; pull.mergeable === null && i < pollAttempts; i++) {
        await sleep(pollMs)
        pull = await get()
      }
      return pull
    }
    const attempts = (): MergeAttempts | undefined => (polls > 1 || message405 !== undefined ? { polls, putCalls, ...(message405 !== undefined ? { message405 } : {}) } : undefined)
    const withAttempts = (record: MergeRecord): MergeRecord => {
      const evidence = attempts()
      return evidence ? { ...record, attempts: evidence } : record
    }
    const put = async (title: string): Promise<{ code: number; stdout: Buffer; stderr: string }> => {
      putCalls++
      return ghRaw(o.token, [endpoint + '/merge', '-X', 'PUT', '--input', '-'], { run: o.run, input: JSON.stringify({ merge_method: 'squash', sha: pick.head, commit_title: title, commit_message: '' }) })
    }
    const statusOf = (stderr: string): number => Number(stderr.match(/HTTP (\d{3})/)?.[1] ?? 0)
    const pull = await settle()
    const title = squashTitle(pick.kind, pull.title, pick.pull)
    const problems = commitProblems(title)
    if (problems.length > 0) {
      records.push(withAttempts({ kind: pick.kind, pull: pick.pull, sha: pick.head, merged: false, reason: 'title: ' + problems.join('; ') }))
      continue
    }
    if (pull.mergeable === false) {
      records.push(withAttempts({ kind: pick.kind, pull: pick.pull, sha: pick.head, merged: false, reason: 'not mergeable (mergeable=false, state=' + pull.mergeable_state + ')' }))
      continue
    }
    let response = await put(title)
    if (response.code !== 0 && statusOf(response.stderr) === 405) {
      message405 = response.stderr.trim().slice(0, 300)
      const again = await settle()
      if (again.mergeable === false) {
        records.push(withAttempts({ kind: pick.kind, pull: pick.pull, sha: pick.head, merged: false, reason: 'not mergeable (HTTP 405): ' + message405 + ' | mergeable=false, state=' + again.mergeable_state }))
        continue
      }
      response = await put(title)
      if (response.code !== 0) {
        const second = response.stderr.trim().slice(0, 300)
        records.push(withAttempts({ kind: pick.kind, pull: pick.pull, sha: pick.head, merged: false, reason: 'not mergeable (HTTP 405): ' + message405 + (second !== message405 ? ' | retry: ' + second : '') }))
        continue
      }
    }
    if (response.code === 0) {
      const body = JSON.parse(response.stdout.toString('utf8')) as { sha: string }
      records.push(withAttempts({ kind: pick.kind, pull: pick.pull, sha: body.sha, merged: true }))
      if (AGENT_BRANCH.test(pull.head.ref)) {
        await ghRaw(o.token, ['repos/' + REPO + '/git/refs/heads/' + pull.head.ref, '-X', 'DELETE'], { run: o.run })
      }
      continue
    }
    const status = statusOf(response.stderr)
    const message = response.stderr.trim().slice(0, 300)
    const reason = status === 409 ? 'head changed or conflict (HTTP 409): ' + message : 'error: HTTP ' + status
    records.push(withAttempts({ kind: pick.kind, pull: pick.pull, sha: pick.head, merged: false, reason }))
  }
  return records
}
