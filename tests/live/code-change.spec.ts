/**
 * Live code-change scenarios against the playground repository: the daemon started through the CLI in auto mode with subscription OAuth, a bug report and a feature request each become one pull request by the agent account with source and test changes, the new bug test fails on the base code, and a PR review adds a commit to the same branch and ticket. A PR head is judged by the playground CI when the workflow is seeded, otherwise by node --test at the root of the head tree (the api workspace tests). Evidence is read from the store, GitHub and the logs. Gated by SUPERAGENT_CLAUDE_LIVE=1 and the three tokens; never prints a token; all GitHub access goes through the guarded helper; cleanup closes only this run's own issues and pull requests and deletes their agent branches.
 */
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Ticket, Trigger } from '../../src/core/index.ts'
import { main } from '../../src/cli/main.ts'
import { DATABASE_FILE, databasePath } from '../../src/app/store.ts'
import { openReadOnly } from '../../src/app/store-read.ts'
import { sleep } from '../fixtures/async.ts'
import { downloadTree, ghJson, ghStatus, localIdentity } from './gh.ts'
import { assertAllowedRepo } from './guard.ts'
import { LIVE_LIMITS, liveConfig } from './code-change-config.ts'
import { AGENT_BRANCH, assertClean, attributionProblems, changeVerdict, ciVerdict, closesIssue, commitProblems, contentProblems, isTestFile, preflight, runNodeTests, runTag, seedPlan, WORKFLOW_PATH } from './rules.ts'
import { loadSeed } from './seed-playground.ts'

const LIVE = process.env.SUPERAGENT_CLAUDE_LIVE === '1'
const AGENT_TOKEN = process.env.SUPERAGENT_CLAUDE_GITHUB_TOKEN?.trim()
const OWNER_TOKEN = process.env.SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN?.trim()
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
const REPO = assertAllowedRepo('ok0/superagent-claude-playground')
const AGENT = 'ok0-worker'
const OWNER = 'ok0'
const RUN = runTag()
const BUG_TITLE = 'Paging through tasks drops the last one'
const BUG_BODY = `@ok0-worker With five tasks, GET /tasks?limit=2 returns two tasks, then two more with nextCursor null, so the fifth task is never listed. A single page drops its last task too. The paging goes through api/src/http/cursor.ts, api/src/http/routes/tasks.ts, api/src/services/task-service.ts and api/src/store/memory-store.ts. Please fix it, add a test under api/test that pages through every task, make sure npm run typecheck and npm test pass at the repository root, and open a pull request.\n\n<!-- live-test ${RUN} -->`
const FEATURE_TITLE = 'Add partial updates for tasks'
const FEATURE_BODY = `@ok0-worker Please add PATCH /tasks/:id that changes only the given fields (title, status, dueDate) of a task. Validate them like task creation, return 400 for invalid fields, 404 for an unknown id and 403 when the caller does not own the task, and respond with the updated task. Add a service-level update with unit tests and an HTTP test in api/test, make sure npm run typecheck and npm test pass at the repository root, and open a pull request.\n\n<!-- live-test ${RUN} -->`
const REVIEW_BODY = 'Please also answer GET /tasks with 400 when limit is 0, negative or not a whole number, and add a test for that case.'

type Line = Record<string, unknown>
interface PullInfo { number: number; html_url: string; title: string; body?: string | null; state: string; merged?: boolean; created_at: string; user: { login: string }; head: { ref: string; sha: string }; base: { sha: string } }
interface ChangedFile { filename: string; status: string }
interface Judgement { mode: 'github' | 'local'; verdict: 'success' | 'failure'; detail: string }

const evidence: Record<string, unknown> = {}
const TOKENS = [AGENT_TOKEN, OWNER_TOKEN, OAUTH].filter((token): token is string => Boolean(token))

const owner = <T = unknown>(args: string[], options?: { input?: string }): Promise<T> => ghJson<T>(OWNER_TOKEN!, args, options)

const createIssue = (title: string, body: string): Promise<{ number: number; html_url: string }> =>
  owner<{ number: number; html_url: string }>(['repos/' + REPO + '/issues', '-X', 'POST', '-f', 'title=' + title, '-f', 'body=' + body])

const filesOf = (n: number): Promise<ChangedFile[]> => owner<ChangedFile[]>(['repos/' + REPO + '/pulls/' + n + '/files?per_page=100'])

async function until<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number, stepMs = 15_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error('timed out: ' + label)
    await sleep(stepMs)
  }
}

function walk(root: string): string[] {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

const withTree = async <T>(sha: string, use: (dir: string) => Promise<T>): Promise<T> => {
  const root = mkdtempSync(join(tmpdir(), 'sac-code-change-tree-'))
  try {
    await downloadTree(OWNER_TOKEN!, REPO, sha, root)
    return await use(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(!LIVE || !AGENT_TOKEN || !OWNER_TOKEN || !OAUTH)('live code change', () => {
  let dir = ''
  let configPath = ''
  let config: Record<string, unknown> = {}
  let startedAt = ''
  let ciMode: 'github' | 'local' = 'local'
  const lines: Line[] = []
  const errs: string[] = []
  const signals = new EventEmitter()
  let exitCode: number | undefined
  let done: Promise<number> = Promise.resolve(-1)
  let failed = false
  let scanned = false
  const created = { issues: [] as number[], pulls: [] as { number: number; ref: string }[] }
  const cleanupErrors: string[] = []
  let bugIssue = 0
  let featureIssue = 0
  let bugPull: PullInfo | undefined
  let featurePull: PullInfo | undefined
  afterEach(ctx => { if (ctx.task.result?.state === 'fail') failed = true })

  const requireBug = (): PullInfo => {
    if (!bugPull) throw new Error('bug PR was not found by the first scenario')
    return bugPull
  }
  const storeRows = <T>(table: string): T[] => {
    const reader = openReadOnly(databasePath(join(dir, 'state')))
    try {
      return reader.db.prepare(`SELECT value FROM ${table}`).all().map(row => JSON.parse(String(row.value)) as T)
    } finally {
      reader.close()
    }
  }
  const storeQuery = (sql: string, ...params: string[]): Record<string, unknown>[] => {
    const reader = openReadOnly(databasePath(join(dir, 'state')))
    try {
      return reader.db.prepare(sql).all(...params) as Record<string, unknown>[]
    } finally {
      reader.close()
    }
  }
  const triggerOfIssue = (n: number): Trigger | undefined =>
    storeRows<Trigger>('trigger').find(trigger => trigger.meta.kind === 'issue' && trigger.meta.number === n && trigger.meta.repository === REPO)
  const agentPullsSince = async (): Promise<PullInfo[]> =>
    (await owner<PullInfo[]>(['repos/' + REPO + '/pulls?state=all&per_page=100'])).filter(pull => pull.user.login === AGENT && Date.parse(pull.created_at) >= Date.parse(startedAt))
  const prFor = (issue: number): Promise<PullInfo> => until(async () => {
    const pulls = await owner<PullInfo[]>(['repos/' + REPO + '/pulls?state=all&per_page=100'])
    return pulls.find(pull => pull.user.login === AGENT && Date.parse(pull.created_at) >= Date.parse(startedAt) && closesIssue(pull.body, REPO, issue))
  }, 1_800_000, 30_000, 'agent PR closing #' + issue)

  const judgeHead = async (head: string): Promise<Judgement> => {
    if (ciMode === 'github') {
      const verdict = await until(async () => {
        const response = await owner<{ check_runs: { status: string; conclusion: string | null }[] }>(['repos/' + REPO + '/commits/' + head + '/check-runs?per_page=100'])
        const value = ciVerdict(response.check_runs)
        return value === 'success' || value === 'failure' ? value : undefined
      }, 900_000, 20_000, 'check runs for ' + head).catch((): 'failure' => 'failure')
      return { mode: 'github', verdict, detail: '' }
    }
    return await withTree(head, async (root): Promise<Judgement> => {
      const result = await runNodeTests(root)
      return { mode: 'local', verdict: result.code === 0 ? 'success' : 'failure', detail: result.output.slice(-2000) }
    })
  }

  const cleanup = async (): Promise<{ pulls: { number: number; state: string; merged: boolean }[]; branches: { ref: string; status: number }[]; issues: { number: number; state: string }[] }> => {
    const attempt = async (label: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run()
      } catch (error) {
        cleanupErrors.push(label + ': ' + (error as Error).message)
      }
    }
    for (const pull of created.pulls) {
      await attempt('close PR ' + pull.number, async () => { await owner(['repos/' + REPO + '/pulls/' + pull.number, '-X', 'PATCH', '-f', 'state=closed']) })
    }
    for (const pull of created.pulls) {
      if (!AGENT_BRANCH.test(pull.ref)) continue
      await attempt('delete branch ' + pull.ref, async () => { await owner(['repos/' + REPO + '/git/refs/heads/' + pull.ref, '-X', 'DELETE']) })
    }
    for (const n of created.issues) {
      await attempt('close issue ' + n, async () => { await owner(['repos/' + REPO + '/issues/' + n, '-X', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=completed']) })
    }
    const verified = { pulls: [] as { number: number; state: string; merged: boolean }[], branches: [] as { ref: string; status: number }[], issues: [] as { number: number; state: string }[] }
    for (const pull of created.pulls) {
      await attempt('verify PR ' + pull.number, async () => {
        const current = await owner<PullInfo>(['repos/' + REPO + '/pulls/' + pull.number])
        verified.pulls.push({ number: pull.number, state: current.state, merged: current.merged === true })
        if (current.state !== 'closed' || current.merged !== false) throw new Error('PR ' + pull.number + ' is not closed and unmerged')
      })
      const status = await ghStatus(OWNER_TOKEN!, 'repos/' + REPO + '/branches/' + pull.ref)
      verified.branches.push({ ref: pull.ref, status })
      if (status !== 404) cleanupErrors.push('branch ' + pull.ref + ' still exists (status ' + status + ')')
    }
    for (const n of created.issues) {
      await attempt('verify issue ' + n, async () => {
        const current = await owner<{ state: string }>(['repos/' + REPO + '/issues/' + n])
        verified.issues.push({ number: n, state: current.state })
        if (current.state !== 'closed') throw new Error('issue ' + n + ' is not closed')
      })
    }
    return verified
  }

  beforeAll(async () => {
    const info = await owner<{ default_branch: string }>(['repos/' + REPO])
    const mainRef = await owner<{ object: { sha: string } }>(['repos/' + REPO + '/git/ref/heads/' + info.default_branch])
    const mainHead = mainRef.object.sha
    const mainTree = new Map<string, string>()
    await withTree(mainHead, async root => {
      for (const path of walk(root)) mainTree.set(relative(root, path).split(sep).join('/'), readFileSync(path, 'utf8'))
    })
    const hasWorkflow = mainTree.has(WORKFLOW_PATH)
    const actions = await owner<{ enabled: boolean }>(['repos/' + REPO + '/actions/permissions'])
    ciMode = hasWorkflow && actions.enabled ? 'github' : 'local'
    evidence.ciMode = ciMode
    expect(seedPlan(loadSeed(hasWorkflow), mainTree).kind, 'playground is not seeded: run pnpm live:seed').toBe('unchanged')
    if (hasWorkflow && !actions.enabled) expect.fail('GitHub Actions is disabled for the playground')
    if (!hasWorkflow) {
      const local = await localIdentity()
      const pf = preflight({ repoStatus: 200, localLogin: local.login, localScopes: local.scopes, actionsEnabled: actions.enabled })
      if (pf.status === 'BLOCKED') evidence.blocked = pf.missing
      else expect.fail('playground CI workflow is not seeded although the local gh login can add it: run node tests/live/seed-playground.ts')
    }
    if (ciMode === 'local') {
      evidence.prChecks = 'BLOCKED(no-workflow-scope)'
      console.log('[BLOCKED] playground CI workflow not seeded; PR heads are judged with node --test locally')
    }

    dir = mkdtempSync(join(tmpdir(), 'sac-code-change-'))
    configPath = join(dir, 'superagent-claude.json')
    config = liveConfig({ repo: REPO, owner: OWNER, stateDir: join(dir, 'state') })
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    startedAt = new Date().toISOString()
    done = main(['start', '--config', configPath], {
      out: s => { for (const line of s.split('\n')) if (line.trim()) lines.push(JSON.parse(line) as Line) },
      err: s => { errs.push(s) },
      cwd: dir,
      env: process.env,
      signals,
    }).then(code => { exitCode = code; return code })
    await until(() => {
      if (exitCode !== undefined) throw new Error(errs.join(''))
      return lines.find(line => line.event === 'runtime.started')
    }, 90_000, 1000, 'runtime.started')
    await sleep(20_000)
  }, 300_000)

  afterAll(async () => {
    if (!dir) return
    try {
      signals.emit('SIGTERM')
      expect(await done).toBe(0)

      const state = join(dir, 'state')
      const files = walk(state)
      const fileHits = files.filter(file => { const buffer = readFileSync(file); return TOKENS.some(token => buffer.includes(token)) }).length
      const lineHits = [...lines.map(line => JSON.stringify(line)), ...errs].filter(text => TOKENS.some(token => text.includes(token))).length
      expect(fileHits).toBe(0)
      expect(lineHits).toBe(0)
      scanned = true
      evidence.tokenScan = { files: fileHits, captured: lineHits }
    } finally {
      evidence.cleanup = await cleanup()
    }
    evidence.cleanupErrors = cleanupErrors
    try {
      const serialized = JSON.stringify({ evidence, config, limits: LIVE_LIMITS, startedAt, warnings: errs })
      const jsonl = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
      expect(TOKENS.some(token => serialized.includes(token) || jsonl.includes(token))).toBe(false)
      const stem = `code-change-${stamp(new Date(startedAt))}`
      const outDir = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, stem + '.json'), JSON.stringify({ config, limits: LIVE_LIMITS, startedAt, warnings: errs, ...evidence }, null, 2))
      writeFileSync(join(outDir, stem + '.jsonl'), jsonl)
      expect(cleanupErrors).toEqual([])
    } finally {
      if (failed && scanned) {
        const kept = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw', `code-change-failed-${stamp(new Date(startedAt))}`)
        mkdirSync(kept, { recursive: true })
        for (const name of readdirSync(join(dir, 'state')).filter(name => name.startsWith(DATABASE_FILE))) copyFileSync(join(dir, 'state', name), join(kept, name))
        writeFileSync(join(kept, 'log.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
        console.log(`[LIVE-KEPT] ${kept}`)
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 900_000)

  it('a bug report and a feature request each become a pull request with source and tests', async () => {
    const bug = await createIssue(assertClean('bug title', BUG_TITLE), assertClean('bug body', BUG_BODY))
    created.issues.push(bug.number)
    bugIssue = bug.number
    const feature = await createIssue(assertClean('feature title', FEATURE_TITLE), assertClean('feature body', FEATURE_BODY))
    created.issues.push(feature.number)
    featureIssue = feature.number
    evidence.issues = { bug: bug.html_url, feature: feature.html_url }

    const [bugPr, featurePr] = await Promise.all([prFor(bug.number), prFor(feature.number)])
    created.pulls.push({ number: bugPr.number, ref: bugPr.head.ref }, { number: featurePr.number, ref: featurePr.head.ref })
    bugPull = bugPr
    featurePull = featurePr

    const scenarios: Record<string, unknown>[] = []
    for (const [label, pr, issueNumber] of [['bug', bugPr, bug.number], ['feature', featurePr, feature.number]] as const) {
      const changed = await filesOf(pr.number)
      expect(changeVerdict(changed.map(file => file.filename)).pass, label + ' PR changes').toBe(true)
      const judged = await judgeHead(pr.head.sha)
      expect(judged.verdict, label + ' PR head judged by ' + judged.mode).toBe('success')
      scenarios.push({ label, issue: issueNumber, pr: pr.number, url: pr.html_url, head: pr.head.sha, files: changed, ci: judged })
    }
    const featureSource = changeVerdict((await filesOf(featurePr.number)).map(f => f.filename)).source
    expect(new Set(featureSource.map(p => p.split('/').slice(0, 3).join('/'))).size, 'feature touches several modules').toBeGreaterThanOrEqual(2)
    const routes = await withTree(featurePr.head.sha, async root => readFileSync(join(root, 'api/src/http/routes/tasks.ts'), 'utf8'))
    expect(routes).toContain('PATCH')
    evidence.scenarios = scenarios
  }, 3_600_000)

  it('the new bug test fails on the code before the fix', async () => {
    const bugPr = requireBug()
    const testFiles = (await filesOf(bugPr.number)).filter(file => isTestFile(file.filename) && file.status !== 'removed').map(file => file.filename)
    const root = mkdtempSync(join(tmpdir(), 'sac-code-change-prefix-'))
    try {
      const base = join(root, 'base')
      const head = join(root, 'head')
      await downloadTree(OWNER_TOKEN!, REPO, bugPr.base.sha, base)
      await downloadTree(OWNER_TOKEN!, REPO, bugPr.head.sha, head)
      const pristine = await runNodeTests(base)
      for (const file of testFiles) {
        mkdirSync(dirname(join(base, file)), { recursive: true })
        copyFileSync(join(head, file), join(base, file))
      }
      const preFix = await runNodeTests(base)
      evidence.preFix = { pristineCode: pristine.code, preFixCode: preFix.code, testFiles, output: preFix.output.slice(-2000) }
      expect(pristine.code).toBe(0)
      expect(preFix.code).not.toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 600_000)

  it('a review on the bug pull request adds a commit in the same ticket and branch', async () => {
    const bugPr = requireBug()
    const number = bugPr.number
    const commitCount = async (): Promise<number> => (await owner<unknown[]>(['repos/' + REPO + '/pulls/' + number + '/commits?per_page=100'])).length
    const before = {
      tickets: storeRows<Ticket>('ticket').map(ticket => ticket.id).sort(),
      pulls: (await agentPullsSince()).length,
      head: (await owner<PullInfo>(['repos/' + REPO + '/pulls/' + number])).head,
      commits: await commitCount(),
    }

    const review = await owner<{ html_url: string }>(['repos/' + REPO + '/pulls/' + number + '/reviews', '-X', 'POST', '--input', '-'], { input: JSON.stringify({ event: 'COMMENT', body: assertClean('review', REVIEW_BODY) }) })
    const newHead = await until(async () => {
      const current = await owner<PullInfo>(['repos/' + REPO + '/pulls/' + number])
      return current.head.sha !== before.head.sha ? current.head.sha : undefined
    }, 1_800_000, 30_000, 'new head on the bug PR')

    const now = await owner<PullInfo>(['repos/' + REPO + '/pulls/' + number])
    expect(now.head.ref).toBe(before.head.ref)
    expect(now.state).toBe('open')
    const commits = await commitCount()
    expect(commits).toBeGreaterThan(before.commits)
    expect(await agentPullsSince()).toHaveLength(before.pulls)
    expect(storeRows<Ticket>('ticket').map(ticket => ticket.id).sort()).toEqual(before.tickets)
    const trigger = triggerOfIssue(bugIssue)
    const ticket = storeRows<Ticket>('ticket').find(row => row.origin.triggerId === trigger?.id)
    expect(ticket).toBeDefined()
    const [worker] = storeQuery('SELECT * FROM worker WHERE ticket_id = ?', ticket!.id)
    expect(worker?.branch).toBe(now.head.ref)
    expect((await judgeHead(newHead)).verdict).toBe('success')
    evidence.review = { review: review.html_url, newHead, commits: { before: before.commits, after: commits } }
  }, 2_400_000)

  it('posted text has no milestone references and commits follow the convention', async () => {
    const problems: string[] = []
    let texts = 0
    let commits = 0
    const check = (label: string, text: string | null | undefined): void => {
      texts++
      problems.push(...contentProblems(label, text ?? ''))
    }
    for (const number of [bugIssue, featureIssue]) {
      const issue = await owner<{ title: string; body?: string | null }>(['repos/' + REPO + '/issues/' + number])
      check('issue ' + number + ' title', issue.title)
      check('issue ' + number + ' body', issue.body)
      for (const comment of await owner<{ body?: string | null }[]>(['repos/' + REPO + '/issues/' + number + '/comments?per_page=100'])) check('issue ' + number + ' comment', comment.body)
    }
    for (const pull of created.pulls) {
      const label = 'PR ' + pull.number
      const detail = await owner<PullInfo>(['repos/' + REPO + '/pulls/' + pull.number])
      check(label + ' title', detail.title)
      check(label + ' body', detail.body)
      problems.push(...attributionProblems(label + ' body', detail.body ?? ''))
      check(label + ' branch', detail.head.ref)
      for (const comment of await owner<{ body?: string | null }[]>(['repos/' + REPO + '/issues/' + pull.number + '/comments?per_page=100'])) check(label + ' comment', comment.body)
      for (const comment of await owner<{ body?: string | null }[]>(['repos/' + REPO + '/pulls/' + pull.number + '/comments?per_page=100'])) check(label + ' review comment', comment.body)
      for (const review of await owner<{ body?: string | null }[]>(['repos/' + REPO + '/pulls/' + pull.number + '/reviews?per_page=100'])) check(label + ' review', review.body)
      for (const commit of await owner<{ commit: { message: string } }[]>(['repos/' + REPO + '/pulls/' + pull.number + '/commits?per_page=100'])) {
        commits++
        problems.push(...commitProblems(commit.commit.message))
      }
    }
    evidence.content = { texts, commits, problems: problems.length }
    expect(problems).toEqual([])
  }, 300_000)
})
