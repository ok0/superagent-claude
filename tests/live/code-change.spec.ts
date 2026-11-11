/**
 * Live code-change scenarios against the playground repository: the daemon started through the CLI in auto mode with subscription OAuth. Scenarios come from the registry in tests/live/scenarios (core always, extended by SUPERAGENT_CLAUDE_LIVE_SCENARIOS). Each initial scenario's issue becomes one agent PR. A scenario passes only when the PR head checks succeed (playground CI, or npm ci, npm run typecheck and npm test locally on the head tree when the workflow is not seeded), its hidden acceptance tests pass on the PR head, and the diff check passes; the bug scenario also needs its new test to fail on the base. A scenario with an answer gets that answer once when the agent asks a question before its pull request, and a scenario that gets a reply and no pull request within the grace period fails instead of waiting out the whole timeout;an ambiguity scenario also needs a question or a stated interpretation; a prepared scenario starts from an owner pull request that adds one failing test. A review follow-up is judged again on the new head with the cumulative PR diff. Evidence is read from the store, GitHub and the logs. Gated by SUPERAGENT_CLAUDE_LIVE=1, a configured SUPERAGENT_CLAUDE_LIVE_REPO with its login settings, and the three tokens; never prints a token; all GitHub access goes through the guarded helper; After judging, the owner squash-merges at most one passing pull request per scenario kind (bug, feature, ui). Cleanup then closes this run's other pull requests without merging, deletes their agent branches, and closes this run's issues.
 */
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Ticket, Trigger } from '../../src/core/index.ts'
import { main } from '../../src/cli/main.ts'
import { DATABASE_FILE, databasePath } from '../../src/app/store.ts'
import { openReadOnly } from '../../src/app/store-read.ts'
import { sleep } from '../fixtures/async.ts'
import { downloadTree, ghJson, ghStatus, localIdentity, tokenLogin } from './gh.ts'
import { assertAllowedRepo } from './guard.ts'
import { liveEnabled, liveTarget } from './target.ts'
import { LIVE_LIMITS, LIVE_WAIT, liveConfig, pullWaitMs } from './code-change-config.ts'
import { AGENT_BRANCH, assertClean, attributionProblems, checkDiff, ciVerdict, closesIssue, commitProblems, contentProblems, isTestFile, preflight, pullPatch, runTag, seedPlan, WORKFLOW_PATH } from './rules.ts'
import { loadSeed } from './seed-playground.ts'
import { judgeScenario, loadScenarios, renderScenario, scenarioFlows } from './scenarios.ts'
import type { LiveScenario } from './scenarios.ts'
import { FIXTURES_DIR, NPM_CACHE_DIR, runHidden, runLocalCi, testsFailOnBase } from './hidden.ts'
import { judgeAmbiguity, waitForPull } from './ambiguity.ts'
import { flowCandidates, mergeOwnerPulls, pickMerges } from './owner-merge.ts'
import type { MergeVerdict } from './owner-merge.ts'
import type { IssueComment } from './ambiguity.ts'
import { prepareBranch, preparedProblems, preparePull } from './prepare-pr.ts'
import type { PreparedPull } from './prepare-pr.ts'

const TARGET = liveTarget()
const LIVE = liveEnabled()
const AGENT_TOKEN = process.env.SUPERAGENT_CLAUDE_GITHUB_TOKEN?.trim()
const OWNER_TOKEN = process.env.SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN?.trim()
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
const REPO = TARGET ? assertAllowedRepo(TARGET.repo) : ''
const AGENT = TARGET?.agentLogin ?? ''
const OWNER = TARGET?.ownerLogin ?? ''
const RUN = runTag()
const RAW = await loadScenarios(process.env)
const SCENARIOS = TARGET ? RAW.map(s => renderScenario(s, TARGET)) : RAW
const FLOWS = scenarioFlows(SCENARIOS)
const issueBody = (s: LiveScenario): string => s.issue.body + '\n\n<!-- live-test ' + RUN + ' -->'

type Line = Record<string, unknown>
interface PullInfo { number: number; html_url: string; title: string; body?: string | null; state: string; merged?: boolean; created_at: string; user: { login: string }; head: { ref: string; sha: string }; base: { sha: string; ref: string } }
interface ChangedFile { filename: string; status: string; patch?: string; previous_filename?: string }
interface Judgement { mode: 'github' | 'local'; verdict: 'success' | 'failure' | 'timeout'; detail: string }

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
  let mainBranch = ''
  let mainHead = ''
  const lines: Line[] = []
  const errs: string[] = []
  const signals = new EventEmitter()
  let exitCode: number | undefined
  let done: Promise<number> = Promise.resolve(-1)
  let failed = false
  let scanned = false
  const created = { issues: [] as number[], pulls: [] as { number: number; ref: string }[] }
  const merged = new Set<number>()
  const cleanupErrors: string[] = []
  const flowState = new Map<string, { issue: number | null; pull: PullInfo }>()
  const asks: Record<string, { asked: boolean; question: string | null; answerUrl: string | null }> = {}
  const verdicts: Record<string, unknown>[] = []
  afterEach(ctx => { if (ctx.task.result?.state === 'fail') failed = true })

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
  const issueComments = (n: number): Promise<IssueComment[]> => owner<IssueComment[]>(['repos/' + REPO + '/issues/' + n + '/comments?per_page=100'])
  const postComment = (n: number, body: string): Promise<{ html_url: string; created_at: string }> =>
    owner<{ html_url: string; created_at: string }>(['repos/' + REPO + '/issues/' + n + '/comments', '-X', 'POST', '-f', 'body=' + body])
  const findPullFor = async (issue: number): Promise<PullInfo | undefined> =>
    (await owner<PullInfo[]>(['repos/' + REPO + '/pulls?state=all&per_page=100'])).find(pull => pull.user.login === AGENT && Date.parse(pull.created_at) >= Date.parse(startedAt) && closesIssue(pull.body, REPO, issue))
  const fileAt = async (path: string, ref: string): Promise<string | null> => {
    try {
      const file = await owner<{ content: string }>(['repos/' + REPO + '/contents/' + path + '?ref=' + ref])
      return Buffer.from(file.content, 'base64').toString('utf8')
    } catch {
      return null
    }
  }
  const settled = async (n: number): Promise<PullInfo> => {
    const started = Date.now()
    let current = await owner<PullInfo>(['repos/' + REPO + '/pulls/' + n])
    let stableSince = Date.now()
    for (;;) {
      if (Date.now() - stableSince >= LIVE_WAIT.settleMs || Date.now() - started >= LIVE_WAIT.settleCapMs) return current
      await sleep(60_000)
      const next = await owner<PullInfo>(['repos/' + REPO + '/pulls/' + n])
      if (next.head.sha !== current.head.sha) stableSince = Date.now()
      current = next
    }
  }
  const resultPull = async (prepared: PreparedPull, path: string): Promise<PullInfo | undefined> => {
    const current = await owner<PullInfo>(['repos/' + REPO + '/pulls/' + prepared.number])
    if (current.head.sha !== prepared.headSha) return current
    for (const pull of await agentPullsSince()) {
      if (Date.parse(pull.created_at) < Date.parse(prepared.commentAt)) continue
      if (pull.base.ref === prepared.branch || (pull.body ?? '').includes('#' + prepared.number) || (await filesOf(pull.number)).some(f => f.filename === path)) return pull
    }
    return undefined
  }

  const judgeHead = async (head: string): Promise<Judgement> => {
    if (ciMode === 'github') {
      const verdict = await until(async () => {
        const response = await owner<{ check_runs: { status: string; conclusion: string | null }[] }>(['repos/' + REPO + '/commits/' + head + '/check-runs?per_page=100'])
        const value = ciVerdict(response.check_runs)
        return value === 'success' || value === 'failure' ? value : undefined
      }, 900_000, 20_000, 'check runs for ' + head).catch((): 'timeout' => 'timeout')
      return { mode: 'github', verdict, detail: '' }
    }
    return await withTree(head, async (root): Promise<Judgement> => {
      const result = await runLocalCi(root)
      return { mode: 'local', verdict: result.code === 0 ? 'success' : 'failure', detail: result.step + '\n' + result.output.slice(-2000) }
    })
  }

  const baseCheck = async (scenario: LiveScenario, baseSha: string, head: string, files: ChangedFile[]) => {
    const root = mkdtempSync(join(tmpdir(), 'sac-code-change-prefix-'))
    try {
      await downloadTree(OWNER_TOKEN!, REPO, baseSha, join(root, 'base'))
      await downloadTree(OWNER_TOKEN!, REPO, head, join(root, 'head'))
      const testFiles = files.filter(f => isTestFile(f.filename) && f.status !== 'removed').map(f => f.filename)
      return await testsFailOnBase({ base: join(root, 'base'), head: join(root, 'head'), testFiles, cwd: scenario.hidden?.workspace ?? '' })
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  const judgeScenarioHead = async (scenario: LiveScenario, pull: PullInfo, head: string, issue: number | null) => {
    const started = Date.now()
    const files = scenario.prepare ? (await owner<{ files?: ChangedFile[] }>(['repos/' + REPO + '/compare/' + mainHead + '...' + head])).files ?? [] : await filesOf(pull.number)
    const diff = checkDiff(files, pullPatch(files), scenario.diff, { hiddenDest: scenario.hidden?.dest })
    const ambiguity = scenario.ambiguity && issue !== null ? judgeAmbiguity(await issueComments(issue), { body: pull.body, createdAt: pull.created_at }, files.map(f => f.filename), AGENT) : null
    const prepared = scenario.prepare ? { problems: preparedProblems(readFileSync(join(FIXTURES_DIR, scenario.prepare.fixture), 'utf8'), await fileAt(scenario.prepare.path, head)) } : null
    const checks = await judgeHead(head)
    const hidden = scenario.hidden ? await runHidden(head, scenario, { fetchTree: (sha, d) => downloadTree(OWNER_TOKEN!, REPO, sha, d) }) : null
    const base = scenario.diff.newTestFailsOnBase === true ? await baseCheck(scenario, pull.base.sha, head, files) : null
    const verdict = judgeScenario(scenario, { checks: checks.verdict, hidden, diff, base, ambiguity, prepared: prepared && { passed: prepared.problems.length === 0 } })
    verdicts.push({ id: scenario.id, pr: pull.number, url: pull.html_url, head, files: files.map(f => ({ filename: f.filename, status: f.status })), checks, hidden: hidden && { passed: hidden.passed, runs: hidden.runs, output: hidden.output.slice(-2000), install: hidden.install, environment: hidden.install?.environment === true }, diff, base: base && { ...base, output: base.output.slice(-2000) }, ambiguity, prepared, asked: asks[scenario.id] ?? null, verdict, seconds: Math.round((Date.now() - started) / 1000) })
    return verdict
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
      if (merged.has(pull.number)) continue
      await attempt('close PR ' + pull.number, async () => { await owner(['repos/' + REPO + '/pulls/' + pull.number, '-X', 'PATCH', '-f', 'state=closed']) })
    }
    for (const pull of created.pulls) {
      if (merged.has(pull.number) || !AGENT_BRANCH.test(pull.ref)) continue
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
        const expectMerged = merged.has(pull.number)
        if (current.state !== 'closed' || (current.merged === true) !== expectMerged) throw new Error('PR ' + pull.number + (expectMerged ? ' is not merged' : ' is not closed and unmerged'))
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
    const info = await owner<{ default_branch: string; archived?: boolean }>(['repos/' + REPO])
    const mainRef = await owner<{ object: { sha: string } }>(['repos/' + REPO + '/git/ref/heads/' + info.default_branch])
    mainBranch = info.default_branch
    mainHead = mainRef.object.sha
    const mainTree = new Map<string, string>()
    await withTree(mainHead, async root => {
      for (const path of walk(root)) mainTree.set(relative(root, path).split(sep).join('/'), readFileSync(path, 'utf8'))
    })
    const hasWorkflow = mainTree.has(WORKFLOW_PATH)
    const actions = await owner<{ enabled: boolean }>(['repos/' + REPO + '/actions/permissions'])
    ciMode = hasWorkflow && actions.enabled ? 'github' : 'local'
    evidence.ciMode = ciMode
    evidence.scenarioIds = SCENARIOS.map(s => s.id)
    expect(seedPlan(loadSeed(hasWorkflow), mainTree).kind, 'playground is not seeded: run pnpm live:seed').toBe('unchanged')
    if (hasWorkflow && !actions.enabled) expect.fail('GitHub Actions is disabled for the playground')
    if (!hasWorkflow) {
      const local = await localIdentity()
      const pf = preflight({ target: TARGET!,repoStatus: 200, archived: info.archived === true, tokenLogin: await tokenLogin(OWNER_TOKEN!), localLogin: local.login, localScopes: local.scopes, actionsEnabled: actions.enabled })
      if (pf.status === 'BLOCKED') evidence.blocked = pf.missing
      else expect.fail('playground CI workflow is not seeded although the local gh login can add it: run node tests/live/seed-playground.ts')
    }
    if (ciMode === 'local') {
      evidence.prChecks = 'BLOCKED(no-workflow-scope)'
      console.log('[BLOCKED] playground CI workflow not seeded; PR heads are judged with npm ci, typecheck and test locally')
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
      try { evidence.workers = storeQuery('SELECT ticket_id, turns, cost_usd FROM worker') } catch (error) { evidence.workers = String((error as Error).message) }
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
      try {
        const merges = await mergeOwnerPulls(pickMerges(flowCandidates(FLOWS, verdicts as unknown as MergeVerdict[])), { token: OWNER_TOKEN! })
        for (const entry of merges) {
          if (entry.merged) merged.add(entry.pull)
          if (entry.reason?.startsWith('error:')) cleanupErrors.push('merge PR ' + entry.pull + ': ' + entry.reason)
        }
        evidence.merges = merges
      } catch (error) {
        cleanupErrors.push('merge: ' + (error as Error).message)
        evidence.merges = []
      }
      evidence.cleanup = await cleanup()
      evidence.elapsedSeconds = Math.round((Date.now() - Date.parse(startedAt)) / 1000)
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
      rmSync(NPM_CACHE_DIR, { recursive: true, force: true })
    }
  }, 900_000)

  it('every selected issue becomes a pull request that passes its verdict', async () => {
    const issueUrls: Record<string, string> = {}
    evidence.issues = issueUrls
    evidence.asks = asks
    const startFlow = async (flow: (typeof FLOWS)[number]): Promise<void> => {
      const s = flow.initial
      const spec = s.prepare
      if (spec) {
        const prepared = await preparePull({
          call: owner,
          repo: REPO,
          base: { branch: mainBranch, sha: mainHead },
          branch: prepareBranch(RUN),
          spec,
          title: s.issue.title,
          body: s.issue.body,
          content: readFileSync(join(FIXTURES_DIR, spec.fixture), 'utf8'),
          agent: AGENT,
          checksOf: async sha => (await judgeHead(sha)).verdict,
          onCreated: p => created.pulls.push(p),
        })
        evidence.prepared = { number: prepared.number, url: prepared.html_url, branch: prepared.branch, commentUrl: prepared.commentUrl }
        const found = await until(() => resultPull(prepared, spec.path), pullWaitMs(FLOWS.length), LIVE_WAIT.stepMs, 'agent fix for the prepared pull request')
        const pull = found.number === prepared.number ? await settled(found.number) : found
        if (found.number !== prepared.number) created.pulls.push({ number: found.number, ref: found.head.ref })
        flowState.set(s.id, { issue: null, pull })
        return
      }
      const issue = await createIssue(assertClean(s.id + ' title', s.issue.title), assertClean(s.id + ' body', issueBody(s)))
      created.issues.push(issue.number)
      issueUrls[s.id] = issue.html_url
      const w = await waitForPull<PullInfo>({
        answer: s.answer,
        agent: AGENT,
        comments: () => issueComments(issue.number),
        postAnswer: body => postComment(issue.number, assertClean(s.id + ' answer', body)),
        findPull: () => findPullFor(issue.number),
        timeoutMs: pullWaitMs(FLOWS.length),
        graceMs: LIVE_WAIT.replyGraceMs,
        stepMs: LIVE_WAIT.stepMs,
        sleep: async (ms: number): Promise<void> => { await sleep(ms) },
      })
      created.pulls.push({ number: w.pull.number, ref: w.pull.head.ref })
      asks[s.id] = { asked: w.asked, question: w.question, answerUrl: w.answerUrl }
      flowState.set(s.id, { issue: issue.number, pull: w.pull })
    }

    const outcomes = await Promise.allSettled(FLOWS.map(startFlow))
    const failures: string[] = []
    outcomes.forEach((outcome, i) => {
      if (outcome.status === 'rejected') failures.push(FLOWS[i]!.initial.id + ': ' + (outcome.reason as Error).message)
    })
    for (const flow of FLOWS) {
      const state = flowState.get(flow.initial.id)
      if (!state) continue
      const verdict = await judgeScenarioHead(flow.initial, state.pull, state.pull.head.sha, state.issue)
      if (!verdict.passed) failures.push(flow.initial.id + ': ' + verdict.failed.join(', '))
    }
    evidence.scenarios = verdicts
    expect(failures, 'failed verdict parts').toEqual([])
  }, pullWaitMs(FLOWS.length) + LIVE_WAIT.settleCapMs + FLOWS.length * LIVE_WAIT.judgePerFlowMs)

  it('a review follow-up adds a commit in the same ticket and branch and passes on the new head', async () => {
    const failures: string[] = []
    const reviews: Record<string, unknown>[] = []
    evidence.reviews = reviews
    for (const flow of FLOWS) {
      for (const followUp of flow.followUps) {
        const state = flowState.get(flow.initial.id)
        if (!state) throw new Error('no pull request for ' + flow.initial.id)
        if (state.issue === null) throw new Error('no issue for ' + flow.initial.id)
        const number = state.pull.number
        const commitCount = async (): Promise<number> => (await owner<unknown[]>(['repos/' + REPO + '/pulls/' + number + '/commits?per_page=100'])).length
        const before = {
          tickets: storeRows<Ticket>('ticket').map(ticket => ticket.id).sort(),
          pulls: (await agentPullsSince()).length,
          head: (await owner<PullInfo>(['repos/' + REPO + '/pulls/' + number])).head,
          commits: await commitCount(),
        }

        const review = await owner<{ html_url: string }>(['repos/' + REPO + '/pulls/' + number + '/reviews', '-X', 'POST', '--input', '-'], { input: JSON.stringify({ event: 'COMMENT', body: assertClean('review', followUp.review!.body) }) })
        const newHead = await until(async () => {
          const current = await owner<PullInfo>(['repos/' + REPO + '/pulls/' + number])
          return current.head.sha !== before.head.sha ? current.head.sha : undefined
        }, 1_800_000, 30_000, 'new head on the pull request of ' + flow.initial.id)

        const now = await owner<PullInfo>(['repos/' + REPO + '/pulls/' + number])
        expect(now.head.ref).toBe(before.head.ref)
        expect(now.state).toBe('open')
        const commits = await commitCount()
        expect(commits).toBeGreaterThan(before.commits)
        expect(await agentPullsSince()).toHaveLength(before.pulls)
        expect(storeRows<Ticket>('ticket').map(ticket => ticket.id).sort()).toEqual(before.tickets)
        const trigger = triggerOfIssue(state.issue)
        const ticket = storeRows<Ticket>('ticket').find(row => row.origin.triggerId === trigger?.id)
        expect(ticket).toBeDefined()
        const [worker] = storeQuery('SELECT * FROM worker WHERE ticket_id = ?', ticket!.id)
        expect(worker?.branch).toBe(now.head.ref)
        const current = await owner<PullInfo>(['repos/' + REPO + '/pulls/' + number])
        const verdict = await judgeScenarioHead(followUp, current, newHead, state.issue)
        if (!verdict.passed) failures.push(followUp.id + ': ' + verdict.failed.join(', '))
        reviews.push({ id: followUp.id, review: review.html_url, newHead, commits: { before: before.commits, after: commits } })
      }
    }
    expect(failures).toEqual([])
  }, 3_000_000)

  it('posted text has no milestone references and commits follow the convention', async () => {
    const problems: string[] = []
    let texts = 0
    let commits = 0
    const check = (label: string, text: string | null | undefined): void => {
      texts++
      problems.push(...contentProblems(label, text ?? ''))
    }
    for (const number of created.issues) {
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
