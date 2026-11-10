import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { checkMessage } from '../../scripts/check-commits.ts'
import { assertAllowedRepo } from './guard.ts'

export const MILESTONE_ID = /\bM\d+\b/
export const MILESTONE_WORD = /milestone/i

export function contentProblems(label: string, text: string): string[] {
  const problems: string[] = []
  const id = text.match(MILESTONE_ID)
  if (id) problems.push(label + ': milestone id ' + id[0])
  if (MILESTONE_WORD.test(text)) problems.push(label + ': word milestone')
  return problems
}

export function assertClean(label: string, text: string): string {
  const problems = contentProblems(label, text)
  if (problems.length > 0) throw new Error(problems.join('; '))
  return text
}

export function commitProblems(message: string): string[] {
  return [...checkMessage(message), ...contentProblems('commit', message)]
}

export function runTag(bytes: Buffer = randomBytes(4)): string {
  return 'run-' + bytes.toString('hex')
}

export function closesIssue(body: string | null | undefined, repo: string, n: number): boolean {
  if (!body) return false
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:#|${escaped}#|https://github\.com/${escaped}/issues/)${n}(?![0-9])`, 'i')
  return pattern.test(body)
}

export const isTestFile = (p: string): boolean => /^test\//.test(p) || /\.test\.[cm]?js$/.test(p)
export const isSourceFile = (p: string): boolean => /^src\/.+\.[cm]?js$/.test(p) && !isTestFile(p)
const isDocFile = (p: string): boolean => /\.(md|markdown|txt)$/i.test(p) || /^docs\//.test(p)

export interface ChangeVerdict { source: string[]; tests: string[]; other: string[]; pass: boolean; reason?: 'empty' | 'docs-only' | 'no-source' | 'no-test' }

export function changeVerdict(files: readonly string[]): ChangeVerdict {
  const source = files.filter(isSourceFile)
  const tests = files.filter(isTestFile)
  const other = files.filter(f => !isSourceFile(f) && !isTestFile(f))
  const pass = source.length > 0 && tests.length > 0
  if (pass) return { source, tests, other, pass }
  let reason: 'empty' | 'docs-only' | 'no-source' | 'no-test'
  if (files.length === 0) reason = 'empty'
  else if (files.every(isDocFile)) reason = 'docs-only'
  else if (source.length === 0) reason = 'no-source'
  else reason = 'no-test'
  return { source, tests, other, pass, reason }
}

export type Preflight = { status: 'ready' } | { status: 'BLOCKED'; missing: ('workflow-scope' | 'actions-disabled')[]; actions: string[] }

export function preflight(input: { scopes: readonly string[]; actionsEnabled: boolean }): Preflight {
  const missing: ('workflow-scope' | 'actions-disabled')[] = []
  const actions: string[] = []
  if (!input.scopes.some(scope => scope.toLowerCase() === 'workflow')) {
    missing.push('workflow-scope')
    actions.push('Give the owner token the workflow scope (for example "gh auth refresh --scopes workflow", or a new classic token with repo and workflow) and export it as SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN.')
  }
  if (!input.actionsEnabled) {
    missing.push('actions-disabled')
    actions.push('Enable GitHub Actions for ok0/superagent-claude-playground (Settings > Actions > General > Allow all actions).')
  }
  if (missing.length === 0) return { status: 'ready' }
  return { status: 'BLOCKED', missing, actions }
}

export const WORKFLOW_PATH = '.github/workflows/test.yml'

export interface SeedFile { path: string; content: string }

export function blobSha(content: string | Buffer): string {
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + body.length + '\0'), body])).digest('hex')
}

export type SeedPlan = { kind: 'unchanged' } | { kind: 'create'; paths: string[] } | { kind: 'diff'; problems: string[] }

export function seedPlan(expected: readonly SeedFile[], remote: ReadonlyMap<string, string>): SeedPlan {
  const present = expected.filter(file => remote.has(file.path))
  const differing = present.filter(file => remote.get(file.path) !== file.content)
  if (differing.length > 0) return { kind: 'diff', problems: differing.map(file => file.path + ': content differs') }
  const missing = expected.filter(file => !remote.has(file.path)).map(file => file.path)
  if (missing.length === 0) return { kind: 'unchanged' }
  if (present.length === 0) return { kind: 'create', paths: expected.map(file => file.path) }
  if (missing.length === 1 && missing[0] === WORKFLOW_PATH) return { kind: 'create', paths: [WORKFLOW_PATH] }
  return { kind: 'diff', problems: missing.map(path => path + ': missing while other seed files exist') }
}

export function seedWorkflowProblems(text: string): string[] {
  const problems: string[] = []
  const lines = text.split('\n')
  const onIndex = lines.findIndex(line => line === 'on:')
  const keys: string[] = []
  if (onIndex >= 0) {
    for (let i = onIndex + 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() !== '' && !line.startsWith(' ')) break
      const match = /^  ([A-Za-z_][\w-]*):/.exec(line)
      if (match) keys.push(match[1] ?? '')
    }
  }
  const sortedKeys = [...keys].sort()
  if (JSON.stringify(sortedKeys) !== JSON.stringify(['pull_request', 'push'])) problems.push('on: keys must be exactly push and pull_request')
  if (text.includes('pull_request_target')) problems.push('pull_request_target is not allowed')
  const permissionLines = lines.map((line, index) => ({ line, index })).filter(entry => /^\s*permissions:/.test(entry.line))
  const topPermissions = permissionLines.length === 1 && permissionLines[0] !== undefined && /^permissions:\s*$/.test(permissionLines[0].line) ? permissionLines[0] : undefined
  if (!topPermissions) {
    problems.push('exactly one top-level permissions: line is required')
  } else {
    const block: string[] = []
    for (let i = topPermissions.index + 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '') continue
      if (!line.startsWith(' ')) break
      block.push(line)
    }
    if (JSON.stringify(block) !== JSON.stringify(['  contents: read'])) problems.push('permissions block must be exactly contents: read')
  }
  for (const match of text.matchAll(/uses:\s*(\S+)/g)) {
    if (!/^actions\/[A-Za-z0-9_.-]+@v\d+$/.test(match[1] ?? '')) problems.push('uses must be a pinned official action: ' + (match[1] ?? ''))
  }
  if (text.includes('secrets.')) problems.push('secrets. is not allowed')
  if (!text.includes('npm test')) problems.push('npm test is required')
  return problems
}

export type CiVerdict = 'none' | 'pending' | 'success' | 'failure'

export function ciVerdict(checks: readonly { status: string; conclusion: string | null }[]): CiVerdict {
  if (checks.length === 0) return 'none'
  if (checks.some(check => check.status !== 'completed')) return 'pending'
  if (checks.every(check => check.conclusion === 'success')) return 'success'
  return 'failure'
}

export async function runNodeTests(dir: string, timeoutMs = 180_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test'], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir } })
    const chunks: string[] = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: 124, output: chunks.join('') })
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output: chunks.join('') })
    })
  })
}

export const AGENT_BRANCH = /^agent\/[A-Za-z0-9._-]+$/
export const PLAYGROUND_REPOS = ['ok0/superagent-claude-playground', 'ok0/superagent-claude-playground-readonly'] as const

export interface RemoteIssue { number: number; state: string; user: { login: string }; pull_request?: unknown }
export interface RemotePull { number: number; state: string; user: { login: string }; head: { ref: string } }
export interface RemoteBranch { name: string; protected?: boolean }
export interface CleanupTargets { repo: string; reportOnly: boolean; issues: number[]; pulls: number[]; branches: string[] }

export function cleanupTargets(input: { repo: string; defaultBranch: string; issues: readonly RemoteIssue[]; pulls: readonly RemotePull[]; branches: readonly RemoteBranch[]; authors: readonly string[]; agent: string }): CleanupTargets {
  assertAllowedRepo(input.repo)
  const repoLower = input.repo.toLowerCase()
  const reportOnly = !PLAYGROUND_REPOS.some(repo => repo === repoLower)
  const authors = new Set(input.authors.map(author => author.toLowerCase()))
  const agent = input.agent.toLowerCase()
  const byNumber = (a: number, b: number): number => a - b
  const openPulls = input.pulls.filter(pull => pull.state === 'open')

  if (reportOnly) {
    const issues = input.issues
      .filter(issue => issue.state === 'open' && !issue.pull_request && issue.user.login.toLowerCase() === agent)
      .map(issue => issue.number)
      .sort(byNumber)
    const pulls = openPulls
      .filter(pull => pull.user.login.toLowerCase() === agent || AGENT_BRANCH.test(pull.head.ref))
      .map(pull => pull.number)
      .sort(byNumber)
    const branches = input.branches
      .filter(branch => AGENT_BRANCH.test(branch.name) && branch.name !== input.defaultBranch && !branch.protected)
      .map(branch => branch.name)
      .sort((a, b) => a.localeCompare(b))
    return { repo: input.repo, reportOnly, issues, pulls, branches }
  }

  const issues = input.issues
    .filter(issue => issue.state === 'open' && !issue.pull_request && authors.has(issue.user.login.toLowerCase()))
    .map(issue => issue.number)
    .sort(byNumber)
  const targetPulls = openPulls.filter(pull => authors.has(pull.user.login.toLowerCase()))
  const pulls = targetPulls.map(pull => pull.number).sort(byNumber)
  const keptHeads = new Set(openPulls.filter(pull => !targetPulls.includes(pull)).map(pull => pull.head.ref))
  const branches = input.branches
    .filter(branch => AGENT_BRANCH.test(branch.name) && branch.name !== input.defaultBranch && !branch.protected && !keptHeads.has(branch.name))
    .map(branch => branch.name)
    .sort((a, b) => a.localeCompare(b))
  return { repo: input.repo, reportOnly, issues, pulls, branches }
}
