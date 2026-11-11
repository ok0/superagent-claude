import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { ATTRIBUTION_PATTERNS, checkMessage } from '../../scripts/check-commits.ts'
import { isAiAttributionLine } from '../../src/infra/text.ts'
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

export const isTestFile = (p: string): boolean => /(^|\/)test\//.test(p) || /\.test\.[cm]?[jt]sx?$/.test(p)
export const isSourceFile = (p: string): boolean => /(^|\/)src\/.+\.[cm]?[jt]sx?$/.test(p) && !isTestFile(p)
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

export const LOCAL_GH_ACCOUNT = 'ok0'

export type PreflightMissing = 'repo-access' | 'local-gh-account' | 'workflow-scope' | 'actions-disabled'
export type Preflight = { status: 'ready' } | { status: 'BLOCKED'; missing: PreflightMissing[]; actions: string[] }

export function preflight(input: { repoStatus: number; localLogin: string | null; localScopes: readonly string[]; actionsEnabled: boolean }): Preflight {
  const missing: PreflightMissing[] = []
  const actions: string[] = []
  if (input.repoStatus !== 200) {
    missing.push('repo-access')
    actions.push('Make sure the empty private repository ok0/superagent-claude-playground exists and that SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN can read and write it.')
  }
  if ((input.localLogin ?? '').toLowerCase() !== LOCAL_GH_ACCOUNT) {
    missing.push('local-gh-account')
    actions.push('Log in the local gh CLI as ok0 (gh auth login, or gh auth switch --user ok0).')
  }
  if (!input.localScopes.some(scope => scope.toLowerCase() === 'workflow')) {
    missing.push('workflow-scope')
    actions.push('Add the workflow scope to the local gh login: gh auth refresh --scopes workflow.')
  }
  if (!input.actionsEnabled) {
    missing.push('actions-disabled')
    actions.push('Enable GitHub Actions for ok0/superagent-claude-playground (Settings > Actions > General > Allow all actions).')
  }
  if (missing.length === 0) return { status: 'ready' }
  return { status: 'BLOCKED', missing, actions }
}

export function ciBlockedLabel(missing: readonly PreflightMissing[]): string {
  return missing.length > 0 && missing.every(entry => entry === 'actions-disabled') ? 'BLOCKED(actions-disabled)' : 'BLOCKED(no-workflow-scope)'
}

export const WORKFLOW_PATH = '.github/workflows/test.yml'

export interface SeedFile { path: string; content: string }

export function blobSha(content: string | Buffer): string {
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + body.length + '\0'), body])).digest('hex')
}

export function attributionProblems(label: string, text: string): string[] {
  const problems: string[] = []
  const lines = text.split(/\r?\n/)
  const shared = lines.find(isAiAttributionLine)
  if (shared !== undefined) problems.push(label + ': contains AI attribution "' + shared.trim() + '"')
  for (const pattern of ATTRIBUTION_PATTERNS) {
    const line = lines.find(candidate => pattern.test(candidate))
    if (line !== undefined) problems.push(label + ': contains AI attribution "' + line.trim() + '"')
  }
  return problems
}

export const SEED_VERSION_PATH = '.seed-version'
export function seedVersion(files: readonly SeedFile[]): string {
  return createHash('sha256')
    .update(files.filter(f => f.path !== SEED_VERSION_PATH && f.path !== WORKFLOW_PATH).map(f => f.path + '\0' + blobSha(f.content)).sort().join('\n'))
    .digest('hex')
}

export const SEED_README_FACTS: readonly { fact: string; pattern: RegExp }[] = [
  { fact: 'it is the test playground for superagent-claude', pattern: /\btest playground for superagent-claude\b/i },
  { fact: 'it is not a real project', pattern: /\bnot a real (project|repository)\b/i },
  { fact: 'automated tests open and close its issues and pull requests', pattern: /\bissues and pull requests are (opened|created) and closed by automated tests\b/i },
]

export function readmeProblems(text: string): string[] {
  const lines = text.split(/\r?\n/)
  let start = 0
  while (start < lines.length && ((lines[start] ?? '').trim() === '' || (lines[start] ?? '').startsWith('#'))) start++
  const paragraph: string[] = []
  for (let i = start; i < lines.length && (lines[i] ?? '').trim() !== ''; i++) paragraph.push(lines[i] ?? '')
  const first = paragraph.join(' ')
  return SEED_README_FACTS.filter(entry => !entry.pattern.test(first)).map(entry => 'README first paragraph does not say ' + entry.fact)
}

export type SeedPlan ={ kind: 'unchanged' } | { kind: 'create'; paths: string[] } | { kind: 'diff'; problems: string[] }

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
  if (!/^\s+node-version:\s*24\s*$/m.test(text)) problems.push('node-version must be 24')
  const runs = [...text.matchAll(/^\s+- run: (.+)$/gm)].map(match => match[1] ?? '')
  if (JSON.stringify(runs) !== JSON.stringify(['npm ci', 'npm run typecheck', 'npm test'])) problems.push('steps must run npm ci, npm run typecheck, npm test in order')
  return problems
}

export type CiVerdict = 'none' | 'pending' | 'success' | 'failure'

export function ciVerdict(checks: readonly { status: string; conclusion: string | null }[]): CiVerdict {
  if (checks.length === 0) return 'none'
  if (checks.some(check => check.status !== 'completed')) return 'pending'
  if (checks.every(check => check.conclusion === 'success')) return 'success'
  return 'failure'
}

export async function runNodeTests(dir: string, timeoutMs = 180_000, env: Readonly<Record<string, string>> = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test'], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir, ...env } })
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
export const PLAYGROUND_REPOS = ['ok0/superagent-claude-playground'] as const

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
