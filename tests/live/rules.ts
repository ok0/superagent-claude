import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { ATTRIBUTION_PATTERNS, checkMessage } from '../../scripts/check-commits.ts'
import { isAiAttributionLine } from '../../src/infra/text.ts'
import { assertAllowedRepo } from './guard.ts'
import { requireLiveTarget, type LiveEnv, type LiveTarget } from './target.ts'

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
export const isSourceOrStyle = (p: string): boolean => !isTestFile(p) && (isSourceFile(p) || /(^|\/)src\/.+\.css$/.test(p))
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

export type PreflightMissing = 'repo-access' | 'repo-archived' | 'token-login' | 'agent-token-login' | 'local-gh-account' | 'workflow-scope' | 'actions-disabled'
export const HARD_PREFLIGHT: readonly PreflightMissing[] = ['repo-access', 'repo-archived', 'token-login', 'agent-token-login']
export type Preflight = { status: 'ready' } | { status: 'BLOCKED'; missing: PreflightMissing[]; actions: string[] }

export function preflight(input: {
  target: LiveTarget
  repoStatus: number
  archived: boolean
  tokenLogin: string | null
  agentTokenLogin?: string | null
  localLogin: string | null
  localScopes: readonly string[]
  actionsEnabled: boolean
}): Preflight {
  const missing: PreflightMissing[] = []
  const actions: string[] = []
  const eq = (a: string | null | undefined, b: string): boolean => (a ?? '').toLowerCase() === b.toLowerCase()
  const t = input.target
  if (input.repoStatus !== 200) {
    missing.push('repo-access')
    actions.push('Make sure the empty private repository ' + t.repo + ' exists and that SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN can read and write it.')
  }
  if (input.archived) {
    missing.push('repo-archived')
    actions.push(t.repo + ' is archived. Point SUPERAGENT_CLAUDE_LIVE_REPO at an active repository.')
  }
  if (!eq(input.tokenLogin, t.ownerLogin)) {
    missing.push('token-login')
    actions.push('SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN must belong to ' + t.ownerLogin + ' (SUPERAGENT_CLAUDE_LIVE_OWNER_LOGIN).')
  }
  if (input.agentTokenLogin !== undefined && !eq(input.agentTokenLogin, t.agentLogin)) {
    missing.push('agent-token-login')
    actions.push('SUPERAGENT_CLAUDE_GITHUB_TOKEN must belong to ' + t.agentLogin + ' (SUPERAGENT_CLAUDE_LIVE_AGENT_LOGIN).')
  }
  if (!eq(input.localLogin, t.ownerLogin)) {
    missing.push('local-gh-account')
    actions.push('Log in the local gh CLI as ' + t.ownerLogin + ' (gh auth login, or gh auth switch --user ' + t.ownerLogin + ').')
  }
  if (!input.localScopes.some(scope => scope.toLowerCase() === 'workflow')) {
    missing.push('workflow-scope')
    actions.push('Add the workflow scope to the local gh login: gh auth refresh --scopes workflow.')
  }
  if (!input.actionsEnabled) {
    missing.push('actions-disabled')
    actions.push('Enable GitHub Actions for ' + t.repo + ' (Settings > Actions > General > Allow all actions).')
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

export const SEED_MESSAGES = {
  create: 'feat: add a task tracker with api and web workspaces',
  workflow: 'ci: add test workflow',
  upgrade: 'feat: update the task tracker seed with api and web workspaces',
  workflowUpdate: 'ci: install, typecheck and test every workspace',
  reset: 'chore: reset the playground to the test seed',
} as const
export const HARNESS_HISTORY_LIMIT = 50
export interface HistoryCommit { sha: string; commit: { message: string } }
export interface HarnessPull { number: number; merged_at: string | null; merge_commit_sha: string | null; head: { ref: string }; user: { login: string }; merged_by: { login: string } | null }

const SEED_MESSAGE_SET: ReadonlySet<string> = new Set<string>(Object.values(SEED_MESSAGES))

export function seedCommitIndex(commits: readonly HistoryCommit[]): number {
  return commits.slice(0, HARNESS_HISTORY_LIMIT).findIndex(commit => SEED_MESSAGE_SET.has((commit.commit.message.split('\n')[0] ?? '').trim()))
}

export function harnessMergesOnly(commits: readonly HistoryCommit[], pullsBySha: ReadonlyMap<string, readonly HarnessPull[]>, logins: { agentLogin: string; ownerLogin: string }): boolean {
  const at = seedCommitIndex(commits)
  if (at <= 0) return false
  return commits.slice(0, at).every(commit =>
    (pullsBySha.get(commit.sha) ?? []).some(pull =>
      pull.merged_at !== null &&
      pull.merge_commit_sha === commit.sha &&
      AGENT_BRANCH.test(pull.head.ref) &&
      pull.user.login.toLowerCase() === logins.agentLogin.toLowerCase() &&
      pull.merged_by?.login.toLowerCase() === logins.ownerLogin.toLowerCase(),
    ),
  )
}

export type SeedPlan ={ kind: 'unchanged' } | { kind: 'create'; paths: string[] } | { kind: 'diff'; problems: string[] } | { kind: 'reset'; changed: string[]; removed: string[] }

export function seedPlan(expected: readonly SeedFile[], remote: ReadonlyMap<string, string>, opts: { harnessMergesOnly?: boolean } = {}): SeedPlan {
  if (opts.harnessMergesOnly === true && expected.some(f => remote.has(f.path))) {
    const changed = expected.filter(f => f.path !== WORKFLOW_PATH && remote.get(f.path) !== f.content).map(f => f.path)
    const removed = [...remote.keys()].filter(p => !p.startsWith('.github/workflows/') && !expected.some(f => f.path === p)).sort()
    if (changed.length + removed.length > 0) return { kind: 'reset', changed, removed }
  }
  const present = expected.filter(file => remote.has(file.path))
  const differing = present.filter(file => remote.get(file.path) !== file.content)
  if (differing.length > 0) return { kind: 'diff', problems: differing.map(file => file.path + ': content differs') }
  const missing = expected.filter(file => !remote.has(file.path)).map(file => file.path)
  if (missing.length === 0) return { kind: 'unchanged' }
  if (present.length === 0) return { kind: 'create', paths: expected.map(file => file.path) }
  if (missing.length === 1 && missing[0] === WORKFLOW_PATH) return { kind: 'create', paths: [WORKFLOW_PATH] }
  return { kind: 'diff', problems: missing.map(path => path + ': missing while other seed files exist') }
}

const SECRETS_CONTEXT = /\$\{\{(?:(?!\}\})[^\n])*?(?<![\w.-])secrets\b/

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
  if (SECRETS_CONTEXT.test(text)) problems.push('${{ secrets }} references are not allowed')
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

export interface RemoteIssue { number: number; state: string; user: { login: string }; pull_request?: unknown }
export interface RemotePull { number: number; state: string; user: { login: string }; head: { ref: string } }
export interface RemoteBranch { name: string; protected?: boolean }
export interface CleanupTargets { repo: string; reportOnly: boolean; issues: number[]; pulls: number[]; branches: string[] }

export function cleanupTargets(input: { repo: string; defaultBranch: string; issues: readonly RemoteIssue[]; pulls: readonly RemotePull[]; branches: readonly RemoteBranch[]; authors: readonly string[]; agent: string }, env: LiveEnv = process.env): CleanupTargets {
  const target = requireLiveTarget(env)
  assertAllowedRepo(input.repo, env)
  const repoLower = input.repo.toLowerCase()
  const reportOnly = repoLower !== target.repo.toLowerCase()
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

export interface DiffRule { requireSourceAndTest: boolean; allowedRoots?: readonly string[]; allowLockfile?: boolean; newTestFailsOnBase?: boolean; requireSource?: boolean }
export interface DiffFile { filename: string; status: string; previous_filename?: string; patch?: string }
export interface DiffVerdict { pass: boolean; reasons: string[] }
export const LOCKFILES: readonly string[] = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']

export function pullPatch(files: readonly DiffFile[]): string {
  return files.map(f => 'diff --git a/' + (f.previous_filename ?? f.filename) + ' b/' + f.filename + '\n' + (f.patch ?? '')).join('\n')
}

export function patchSections(patch: string): Map<string, { added: string[]; removed: string[] }> {
  const sections = new Map<string, { added: string[]; removed: string[] }>()
  let current: { added: string[]; removed: string[] } | undefined
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (header) {
      current = { added: [], removed: [] }
      sections.set(header[2] ?? '', current)
      continue
    }
    if (!current) continue
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue
    if (line.startsWith('+')) current.added.push(line.slice(1))
    else if (line.startsWith('-')) current.removed.push(line.slice(1))
  }
  return sections
}

const TEST_CALL = /(?<![\w$.])(?:test|it)\s*(?:\.\s*(?:skip|only|todo)\s*)?\(/g
const FOCUS_MARK = /(?<![\w$])(?:test|it|describe|suite|t)\s*\.\s*(?:skip|only|todo)\b|\b(?:skip|only|todo)\s*:\s*(?!false\b)[^\s,}]/g
const count = (lines: readonly string[], re: RegExp): number => lines.reduce((n, l) => n + (l.match(re)?.length ?? 0), 0)

export function checkDiff(files: readonly DiffFile[], patch: string, rule: DiffRule, extra: { hiddenDest?: string } = {}): DiffVerdict {
  const sections = patchSections(patch)
  const paths = (f: DiffFile): string[] => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]
  const reasons: string[] = []
  const add = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  const allPaths = [...new Set(files.flatMap(paths))]
  const hiddenDest = extra.hiddenDest?.replace(/\/$/, '')

  for (const p of allPaths) {
    if (p.startsWith('.github/workflows/')) add('CI workflow changed: ' + p)
  }
  if (hiddenDest) {
    for (const p of allPaths) {
      if (p === hiddenDest || p.startsWith(hiddenDest + '/')) add('hidden test path changed: ' + p)
    }
  }
  for (const p of allPaths) {
    if (LOCKFILES.includes(basename(p)) && rule.allowLockfile !== true) add('lockfile changed: ' + p)
  }
  if (rule.allowedRoots) {
    const roots = rule.allowedRoots
    for (const p of allPaths) {
      if (rule.allowLockfile === true && LOCKFILES.includes(basename(p))) continue
      if (!roots.some(root => p.startsWith(root))) add('outside allowed roots: ' + p)
    }
  }
  for (const f of files.filter(f => isTestFile(f.filename))) {
    const section = sections.get(f.filename)
    if (f.status === 'removed') add('test file removed: ' + f.filename)
    if (f.status !== 'removed' && f.status !== 'renamed' && (!section || (section.added.length === 0 && section.removed.length === 0))) add('no patch for test file: ' + f.filename)
    if (section && count(section.added, FOCUS_MARK) > count(section.removed, FOCUS_MARK)) add('new skip/only/todo: ' + f.filename)
  }
  let calls = 0
  for (const f of files.filter(f => isTestFile(f.filename))) {
    const section = sections.get(f.filename)
    if (section) calls += count(section.removed, TEST_CALL) - count(section.added, TEST_CALL)
  }
  if (calls > 0) add('test count decreased by ' + calls)
  if (rule.requireSourceAndTest) {
    const verdict = changeVerdict(files.map(f => f.filename))
    if (!verdict.pass) add('source and test not both changed: ' + verdict.reason)
  }
  if (rule.requireSource === true && !files.some(f => f.status !== 'removed' && isSourceOrStyle(f.filename))) add('no source change')
  return { pass: reasons.length === 0, reasons }
}
