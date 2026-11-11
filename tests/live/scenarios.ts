import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { contentProblems } from './rules.ts'
import type { DiffRule } from './rules.ts'

export interface HiddenSpec { dir: string; dest: string; workspace: 'api' | 'web'; command: readonly string[]; envMatrix?: readonly Readonly<Record<string, string>>[]; repeat?: number }
export interface LiveScenario { id: string; tier: 'core' | 'extended'; issue: { title: string; body: string }; review?: { body: string }; hidden?: HiddenSpec; diff: DiffRule; ambiguity?: 'clarify-or-state'; answer?: string }

export const SCENARIO_DIR = join(import.meta.dirname, 'scenarios')
export const SCENARIO_ENV = 'SUPERAGENT_CLAUDE_LIVE_SCENARIOS'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const relativePath = (value: unknown): boolean => nonEmpty(value) && !value.startsWith('/') && !value.split('/').includes('..')

export function scenarioProblems(value: unknown): string[] {
  if (!isObject(value)) return ['scenario is not an object']
  const problems: string[] = []
  if (typeof value.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value.id)) problems.push('id must be lowercase words joined by dashes')
  if (value.tier !== 'core' && value.tier !== 'extended') problems.push('tier must be core or extended')
  const issue = isObject(value.issue) ? value.issue : {}
  if (!nonEmpty(issue.title)) problems.push('issue.title must be a non-empty string')
  if (!nonEmpty(issue.body)) problems.push('issue.body must be a non-empty string')
  if (nonEmpty(issue.title)) problems.push(...contentProblems('issue title', issue.title))
  if (nonEmpty(issue.body)) problems.push(...contentProblems('issue body', issue.body))
  const review = value.review
  if (review !== undefined) {
    if (!isObject(review) || !nonEmpty(review.body)) problems.push('review.body must be a non-empty string')
    else problems.push(...contentProblems('review body', review.body))
  }
  const hidden = value.hidden
  if (hidden !== undefined) {
    if (!isObject(hidden)) {
      problems.push('hidden must be an object')
    } else {
      if (!relativePath(hidden.dir)) problems.push('hidden.dir must be a relative path without ..')
      if (!relativePath(hidden.dest)) problems.push('hidden.dest must be a relative path without ..')
      if (hidden.workspace !== 'api' && hidden.workspace !== 'web') problems.push('hidden.workspace must be api or web')
      const command = hidden.command
      if (!Array.isArray(command) || command.length === 0 || !command.every(part => typeof part === 'string')) problems.push('hidden.command must be a non-empty array of strings')
      const envMatrix = hidden.envMatrix
      if (envMatrix !== undefined && (!Array.isArray(envMatrix) || !envMatrix.every(entry => isObject(entry) && Object.values(entry).every(v => typeof v === 'string')))) problems.push('hidden.envMatrix must be an array of objects with string values')
      const repeat = hidden.repeat
      if (repeat !== undefined && (!Number.isInteger(repeat) || (repeat as number) < 1)) problems.push('hidden.repeat must be an integer of at least 1')
    }
  }
  const diff = value.diff
  if (!isObject(diff) || typeof diff.requireSourceAndTest !== 'boolean') {
    problems.push('diff.requireSourceAndTest must be a boolean')
  } else {
    const roots = diff.allowedRoots
    if (roots !== undefined && (!Array.isArray(roots) || !roots.every(root => typeof root === 'string' && root.endsWith('/')))) problems.push('diff.allowedRoots must be strings ending with /')
    if (diff.allowLockfile !== undefined && typeof diff.allowLockfile !== 'boolean') problems.push('diff.allowLockfile must be a boolean')
    if (diff.newTestFailsOnBase !== undefined && typeof diff.newTestFailsOnBase !== 'boolean') problems.push('diff.newTestFailsOnBase must be a boolean')
    if (diff.newTestFailsOnBase === true && hidden === undefined) problems.push('diff.newTestFailsOnBase requires hidden')
  }
  if (value.ambiguity !== undefined && value.ambiguity !== 'clarify-or-state') problems.push("ambiguity must be 'clarify-or-state'")
  if (value.answer !== undefined && typeof value.answer !== 'string') problems.push('answer must be a string')
  return problems
}

export async function loadScenarios(env: Readonly<Record<string, string | undefined>>, dir: string = SCENARIO_DIR): Promise<LiveScenario[]> {
  const files = readdirSync(dir).filter(n => n.endsWith('.ts') && !n.endsWith('.d.ts')).sort()
  const loaded: LiveScenario[] = []
  for (const n of files) {
    const mod = (await import(pathToFileURL(join(dir, n)).href)) as { scenario?: unknown }
    if (mod.scenario === undefined) throw new Error(n + ': no scenario export')
    const problems = scenarioProblems(mod.scenario)
    if (problems.length > 0) throw new Error(n + ': ' + problems.join('; '))
    const scenario = mod.scenario as LiveScenario
    if (loaded.some(s => s.id === scenario.id)) throw new Error('duplicate scenario id: ' + scenario.id)
    loaded.push(scenario)
  }
  const raw = (env[SCENARIO_ENV] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  for (const id of raw) {
    if (!loaded.some(s => s.id === id)) throw new Error('unknown scenario: ' + id)
  }
  return loaded.filter(s => s.tier === 'core' || raw.includes(s.id))
}

export interface ScenarioFlow { initial: LiveScenario; followUps: LiveScenario[] }

export function scenarioFlows(scenarios: readonly LiveScenario[]): ScenarioFlow[] {
  const titles: string[] = []
  for (const s of scenarios) {
    if (!titles.includes(s.issue.title)) titles.push(s.issue.title)
  }
  return titles.map(title => {
    const group = scenarios.filter(s => s.issue.title === title)
    const initials = group.filter(s => s.review === undefined)
    if (initials.length === 0) throw new Error('follow-up without an initial scenario: ' + group.map(s => s.id).join(', '))
    if (initials.length > 1) throw new Error('several initial scenarios share an issue: ' + initials.map(s => s.id).join(', '))
    const initial = initials[0] as LiveScenario
    return { initial, followUps: group.filter(s => s !== initial) }
  })
}

export type VerdictPart = 'checks' | 'hidden' | 'diff' | 'base-failure'

export function judgeScenario(scenario: LiveScenario, input: { checks: string; hidden: { passed: boolean } | null; diff: { pass: boolean }; base: { passed: boolean } | null }): { passed: boolean; failed: VerdictPart[] } {
  const failed: VerdictPart[] = []
  if (input.checks !== 'success') failed.push('checks')
  if (scenario.hidden && input.hidden?.passed !== true) failed.push('hidden')
  if (!input.diff.pass) failed.push('diff')
  if (scenario.diff.newTestFailsOnBase === true && input.base?.passed !== true) failed.push('base-failure')
  return { passed: failed.length === 0, failed }
}
