/**
 * Live branch config check against the playground repository: the daemon started through the CLI in auto mode with a
 * repository entry whose pullRequestTo is dev, then restarted with the same state directory and a pullRequestTo branch
 * that does not exist. The pull request opens against dev and nothing is pushed to dev; the missing branch blocks the
 * ticket with no pull request and one reason comment from the agent account. Gated by ISSUECREW_LIVE=1, a
 * configured ISSUECREW_LIVE_REPO with its login settings, and the three tokens; never prints a token. Closes this
 * run's pull requests, agent branches and issues at the end and keeps dev.
 */
import { EventEmitter } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { Ticket, Trigger } from '../../src/core/index.ts'
import { workspaceBlockedText } from '../../src/core/replies.ts'
import { main } from '../../src/cli/main.ts'
import { DATABASE_FILE, databasePath } from '../../src/app/store.ts'
import { openReadOnly } from '../../src/app/store-read.ts'
import { sleep } from '../fixtures/async.ts'
import { ghJson, ghStatus } from './gh.ts'
import { assertAllowedRepo } from './guard.ts'
import { AGENT_BRANCH, attributionProblems, contentProblems, runTag } from './rules.ts'
import { LIVE_TARGET_ENV, liveEnabled, liveTarget, renderLiveText } from './target.ts'

const TARGET = liveTarget()
const LIVE = liveEnabled()
const AGENT_TOKEN = process.env.ISSUECREW_GITHUB_TOKEN?.trim()
const OWNER_TOKEN = process.env.ISSUECREW_LIVE_OWNER_TOKEN?.trim()
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
const REPO = TARGET ? assertAllowedRepo(TARGET.repo) : ''
const AGENT = TARGET?.agentLogin ?? ''
const OWNER = TARGET?.ownerLogin ?? ''
const text = (value: string): string => (TARGET ? renderLiveText(value, TARGET) : value)
const RUN = runTag()
const LIMITS = { max: 1, maxTurns: 60, maxBudgetUsd: 3 }
const DEV = 'dev'
const MISSING = 'no-such-branch'
const OK_TITLE = 'Add a HELLO file'
const OK_BODY = text(
  '@{{agent}} Please add a file named HELLO.md with one sentence saying hello from the playground, and open a pull request with the change.',
)
const BLOCK_TITLE = 'Add a GREETING file'
const BLOCK_BODY = text(
  '@{{agent}} Please add a file named GREETING.md with one sentence saying good morning, and open a pull request with the change.',
)
const BRANCH_WORDS = /\b(branch|base|dev|main|master|no-such-branch|pullRequestTo|branchFrom)\b/i
const RUN_MARKER = '\n\n<!-- live-test ' + RUN + ' -->'
const MARKER_STRIP = /<!--\s*issuecrew:.*?-->/g
function stripMarker(body: string): string {
  return body.replace(MARKER_STRIP, '').trim()
}
const REPO_ROOT = resolve(import.meta.dirname, '../..')
const OUT_DIR = join(REPO_ROOT, '.docs', 'acceptance')

type Line = Record<string, unknown>
interface Comment {
  id: number
  body: string
  html_url: string
  created_at: string
  user: { login: string }
}
interface Pull {
  number: number
  html_url: string
  title: string
  body?: string | null
  state: string
  created_at: string
  head: { ref: string }
  base: { ref: string }
  user: { login: string }
}
interface Commit {
  sha: string
  html_url: string
  commit: { message: string }
  parents: { sha: string }[]
}
interface Issue {
  number: number
  html_url: string
  title: string
  body?: string | null
  pull_request?: unknown
}
interface Evidence {
  run?: { startedAt: string; tag: string }
  preflight?: {
    env: Record<string, string | undefined>
    defaultBranch: string
    head0: string
    dev: string
    devSha: string
  }
  issueBodies?: { hello: boolean; greeting: boolean }
  success?: {
    issue: string
    issueBody: string
    pr: { number: number; url: string; baseRef: string; head: string }
    firstCommit: string
    parent: string
    head0: string
    headNow: string
    match: boolean
    fixed: unknown
    devAfter: string
    ticketId: string
  }
  blocked?: {
    issue: string
    issueBody: string
    ticketId: string
    state: string
    summary: string
    pulls: number
    newAgentBranches: string[]
  }
  issue2Comments?: { url: string; author: string; body: string; created_at: string }[]
  blockedComment?: { url: string; author: string; body: string; expectedMatch: boolean }
  content?: { scanned: number; problems: string[]; contacted: string[] }
  cleanup?: {
    closedPulls: number[]
    deletedBranches: string[]
    closedIssues: number[]
    remaining: { issues: number[]; pulls: number[] }
    errors: string[]
    devKept: boolean
  }
  tokenScan?: { files: number; captured: number }
  failures?: { test: string; message: string }[]
}

const evidence: Record<string, unknown> = {}
const TOKENS = [AGENT_TOKEN, OWNER_TOKEN, OAUTH].filter((token): token is string => Boolean(token))

async function owner(args: string[]): Promise<unknown> {
  return await ghJson(OWNER_TOKEN!, args)
}

async function createIssue(title: string, body: string): Promise<Issue> {
  return (await owner([
    'repos/' + REPO + '/issues',
    '-X',
    'POST',
    '-f',
    'title=' + title,
    '-f',
    'body=' + body,
  ])) as Issue
}

async function agentPullsSince(since: string): Promise<Pull[]> {
  const all = (await owner(['repos/' + REPO + '/pulls?state=all&per_page=100'])) as Pull[]
  return all.filter(pull => pull.user.login === AGENT && Date.parse(pull.created_at) >= Date.parse(since))
}

async function commitsOf(pr: number): Promise<Commit[]> {
  return (await owner(['repos/' + REPO + '/pulls/' + pr + '/commits?per_page=100'])) as Commit[]
}

async function until<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs: number,
  stepMs = 15_000,
  label = 'condition',
): Promise<T> {
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

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

function renderRecord(record: Record<string, unknown>): string {
  const e = record as Evidence
  const out: string[] = ['# Branch config live check', '']
  const section = (title: string, body: string[] | undefined): void => {
    out.push('## ' + title, '')
    if (body === undefined) {
      const failed = (e.failures ?? []).map(failure => failure.message).join('; ')
      out.push('not reached' + (failed ? ' (failure: ' + failed + ')' : ''), '')
    } else out.push(...body, '')
  }

  section(
    'Run',
    e.run && e.preflight
      ? [
          '- Date: ' + e.run.startedAt,
          '- Run tag: ' + e.run.tag,
          ...Object.entries(e.preflight.env).map(([name, value]) => '- ' + name + ': ' + (value ?? 'unset')),
        ]
      : undefined,
  )
  section(
    'Preflight',
    e.preflight
      ? [
          '- Default branch: ' + e.preflight.defaultBranch,
          '- head0 (default branch head): ' + e.preflight.head0,
          '- dev: ' + e.preflight.dev,
          '- devSha: ' + e.preflight.devSha,
        ]
      : undefined,
  )
  const s = e.success
  section(
    'Pull request against pullRequestTo',
    s
      ? [
          '- Issue: ' + s.issue,
          '',
          '```text',
          s.issueBody,
          '```',
          '',
          '- PR: #' + s.pr.number + ' ' + s.pr.url,
          '- base.ref: ' + s.pr.baseRef,
          '- head: ' + s.pr.head,
          '',
          '| first commit | parent | head0 | match |',
          '| --- | --- | --- | --- |',
          '| ' + s.firstCommit + ' | ' + s.parent + ' | ' + s.head0 + ' | ' + yesNo(s.match) + ' |',
          '',
          '- devAfter: ' + s.devAfter,
          '- Fixed file (state/branches/' + s.ticketId + '.json):',
          '',
          '```json',
          JSON.stringify(s.fixed, null, 2),
          '```',
        ]
      : undefined,
  )
  const b = e.blocked
  section(
    'Missing pullRequestTo',
    b
      ? [
          '- Issue: ' + b.issue,
          '',
          '```text',
          b.issueBody,
          '```',
          '',
          '- Ticket: ' + b.ticketId,
          '- Report state: ' + b.state,
          '- Report summary: ' + b.summary,
          '- Agent pull requests after phase 2 start: ' + String(b.pulls),
          '- New agent branches: ' + (b.newAgentBranches.length > 0 ? b.newAgentBranches.join(', ') : 'none'),
        ]
      : undefined,
  )
  const comments = e.issue2Comments
  section(
    'Blocked comment',
    comments === undefined
      ? undefined
      : e.blockedComment
        ? [
            '- Comment count: ' + String(comments.length),
            '- Author: ' + e.blockedComment.author,
            '- URL: ' + e.blockedComment.url,
            '',
            '```text',
            e.blockedComment.body,
            '```',
            '',
            '- Equals workspaceBlockedText(summary): ' + yesNo(e.blockedComment.expectedMatch),
          ]
        : [
            '- Comment count: ' + String(comments.length),
            ...comments.flatMap((comment, index) => [
              '',
              '### Comment ' + String(index + 1),
              '- Author: ' + comment.author,
              '- URL: ' + comment.url,
              '',
              '```text',
              comment.body,
              '```',
            ]),
          ],
  )
  section(
    'Issue bodies',
    e.issueBodies
      ? [
          '- Hello issue body matches BRANCH_WORDS: ' + yesNo(e.issueBodies.hello),
          '- Greeting issue body matches BRANCH_WORDS: ' + yesNo(e.issueBodies.greeting),
        ]
      : undefined,
  )
  section(
    'Content check',
    e.content
      ? [
          '- Scanned texts: ' + String(e.content.scanned),
          '- Problems: ' + (e.content.problems.length > 0 ? e.content.problems.join('; ') : 'none'),
          '- Contacted repositories: ' + e.content.contacted.join(', '),
        ]
      : undefined,
  )
  const c = e.cleanup
  section(
    'Cleanup',
    c
      ? [
          '- Closed pull requests: ' + (c.closedPulls.join(', ') || 'none'),
          '- Deleted agent branches: ' + (c.deletedBranches.join(', ') || 'none'),
          '- Closed issues: ' + (c.closedIssues.join(', ') || 'none'),
          '- Remaining this run: issues ' +
            (c.remaining.issues.join(', ') || 'none') +
            '; pull requests ' +
            (c.remaining.pulls.join(', ') || 'none'),
          '- Errors: ' + (c.errors.length > 0 ? c.errors.join('; ') : 'none'),
          '- dev kept: ' + yesNo(c.devKept),
        ]
      : undefined,
  )
  section('Verifier checks', ['(filled by the verifier)'])
  return out.join('\n')
}

describe.skipIf(!LIVE || !AGENT_TOKEN || !OWNER_TOKEN || !OAUTH)('live branch config', () => {
  let dir = ''
  let configPath = ''
  let startedAt = ''
  let phase2At = ''
  let defaultBranch = ''
  let head0 = ''
  let devSha = ''
  let ticketId = ''
  let issue2Number = 0
  let summary = ''
  const lines: Line[] = []
  const errs: string[] = []
  const issues: number[] = []
  let signals = new EventEmitter()
  let exitCode: number | undefined
  let done: Promise<number> = Promise.resolve(-1)
  let running = false
  let failed = false
  let scanned = false
  afterEach(ctx => {
    if (ctx.task.result?.state !== 'fail') return
    failed = true
    const failures = (evidence.failures as { test: string; message: string }[] | undefined) ?? []
    evidence.failures = [
      ...failures,
      { test: ctx.task.name, message: (ctx.task.result.errors ?? []).map(error => error.message).join('; ') },
    ]
  })

  const configFor = (to: string): Record<string, unknown> => ({
    repositories: [{ repository: REPO, pullRequestTo: to }],
    policy: { allowed: [OWNER], acceptMode: 'auto' },
    auth: { mode: 'subscription', owner: OWNER },
    delivery: { allowAutoMerge: false },
    workers: LIMITS,
    stateDir: join(dir, 'state'),
  })

  const storeRows = <T>(table: string): T[] => {
    const reader = openReadOnly(databasePath(join(dir, 'state')))
    try {
      return reader.db
        .prepare(`SELECT value FROM ${table}`)
        .all()
        .map(row => JSON.parse(String(row.value)) as T)
    } finally {
      reader.close()
    }
  }
  const triggerOfIssue = (n: number): Trigger | undefined =>
    storeRows<Trigger>('trigger').find(
      trigger => trigger.meta.kind === 'issue' && trigger.meta.number === n && trigger.meta.repository === REPO,
    )
  const ticketById = (id: string): Ticket | undefined => storeRows<Ticket>('ticket').find(ticket => ticket.id === id)

  const statusText = async (): Promise<string> => {
    const out: string[] = []
    const code = await main(['status', '--config', configPath], {
      out: s => {
        out.push(s)
      },
      err: () => {},
      cwd: dir,
      env: process.env,
      signals: new EventEmitter(),
    })
    expect(code).toBe(0)
    return out.join('')
  }
  const idleShown = async (): Promise<string | undefined> => {
    const text = await statusText()
    return text.includes('Idle sessions (1):') && text.includes(ticketId) && text.includes('Running assignments: none')
      ? text
      : undefined
  }

  const start = async (to: string): Promise<void> => {
    writeFileSync(configPath, JSON.stringify(configFor(to), null, 2))
    signals = new EventEmitter()
    exitCode = undefined
    const before = lines.length
    done = main(['start', '--config', configPath], {
      out: s => {
        for (const line of s.split('\n')) if (line.trim()) lines.push(JSON.parse(line) as Line)
      },
      err: s => {
        errs.push(s)
      },
      cwd: dir,
      env: process.env,
      signals,
    }).then(code => {
      exitCode = code
      return code
    })
    running = true
    await until(
      () => {
        if (exitCode !== undefined) throw new Error(errs.join(''))
        return lines.slice(before).find(line => line.event === 'runtime.started')
      },
      90_000,
      1000,
      'runtime.started',
    )
    await sleep(20_000)
  }

  const stop = async (): Promise<void> => {
    running = false
    signals.emit('SIGTERM')
    expect(await done).toBe(0)
  }

  const cleanup: NonNullable<Evidence['cleanup']> = {
    closedPulls: [],
    deletedBranches: [],
    closedIssues: [],
    remaining: { issues: [], pulls: [] },
    errors: [],
    devKept: true,
  }
  const attempt = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run()
    } catch (error) {
      cleanup.errors.push(label + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  it('preflight: dev exists on the target', async () => {
    const repo = (await owner(['repos/' + REPO])) as { default_branch: string; archived: boolean }
    defaultBranch = repo.default_branch
    expect(repo.archived).toBe(false)
    head0 = ((await owner(['repos/' + REPO + '/git/ref/heads/' + defaultBranch])) as { object: { sha: string } }).object
      .sha
    const status = await ghStatus(OWNER_TOKEN!, 'repos/' + REPO + '/git/ref/heads/' + DEV)
    let dev: string
    if (status === 200) dev = 'existed'
    else if (status === 404) {
      await owner(['repos/' + REPO + '/git/refs', '-X', 'POST', '-f', 'ref=refs/heads/' + DEV, '-f', 'sha=' + head0])
      dev = 'created by this run'
    } else throw new Error('unexpected status for dev: ' + String(status))
    devSha = ((await owner(['repos/' + REPO + '/git/ref/heads/' + DEV])) as { object: { sha: string } }).object.sha
    startedAt = new Date().toISOString()
    evidence.run = { startedAt, tag: RUN }
    evidence.preflight = {
      env: Object.fromEntries(Object.values(LIVE_TARGET_ENV).map(name => [name, process.env[name]])),
      defaultBranch,
      head0,
      dev,
      devSha,
    }
    dir = mkdtempSync(join(tmpdir(), 'sac-branch-config-'))
    configPath = join(dir, 'issuecrew.json')
    await start(DEV)
  }, 180_000)

  it('the pull request opens against pullRequestTo', async () => {
    evidence.issueBodies = { hello: BRANCH_WORDS.test(OK_BODY), greeting: BRANCH_WORDS.test(BLOCK_BODY) }
    expect(BRANCH_WORDS.test(OK_BODY)).toBe(false)
    expect(BRANCH_WORDS.test(BLOCK_BODY)).toBe(false)

    const issue = await createIssue(OK_TITLE, OK_BODY + RUN_MARKER)
    issues.push(issue.number)
    const trigger = await until(() => triggerOfIssue(issue.number), 300_000, 5_000, 'trigger for the issue')
    ticketId = await until(
      () => storeRows<Ticket>('ticket').find(ticket => ticket.origin.triggerId === trigger.id)?.id,
      300_000,
      5_000,
      'ticket for the issue',
    )

    const pull = await until(
      async () => {
        const ticket = ticketById(ticketId)
        if (!ticket) return undefined
        const latest = ticket.assignments.at(-1)?.report?.state
        if (ticket.ended || latest === 'failed' || latest === 'blocked')
          throw new Error(`ticket ${ticketId} ended or reported ${String(latest)} before a PR was opened`)
        const pulls = await agentPullsSince(startedAt)
        return pulls.find(
          item =>
            item.head.ref.startsWith('agent/') &&
            ticket.follows?.some(
              follow =>
                follow.own && follow.thread.toLowerCase() === ('github:' + REPO + '#' + item.number).toLowerCase(),
            ),
        )
      },
      900_000,
      20_000,
      'PR opened by the agent for the ticket',
    )
    const n = pull.number
    const pr = (await owner(['repos/' + REPO + '/pulls/' + n])) as Pull
    expect(pr.base.ref).toBe(DEV)

    const commits = await commitsOf(n)
    const parent = commits[0]!.parents[0]!.sha
    const headNow = (
      (await owner(['repos/' + REPO + '/git/ref/heads/' + defaultBranch])) as {
        object: { sha: string }
      }
    ).object.sha
    expect(headNow).toBe(head0)
    expect(parent).toBe(head0)

    const fixed = JSON.parse(readFileSync(join(dir, 'state', 'branches', ticketId + '.json'), 'utf8')) as unknown
    expect(fixed).toEqual({ to: DEV })

    const devAfter = ((await owner(['repos/' + REPO + '/git/ref/heads/' + DEV])) as { object: { sha: string } }).object
      .sha
    expect(devAfter).toBe(devSha)

    await until(idleShown, 900_000, 10_000, 'status shows the idle session')
    await stop()

    evidence.success = {
      issue: issue.html_url,
      issueBody: OK_BODY + RUN_MARKER,
      pr: { number: n, url: pr.html_url, baseRef: pr.base.ref, head: pr.head.ref },
      firstCommit: commits[0]!.sha,
      parent,
      head0,
      headNow,
      match: parent === head0,
      fixed,
      devAfter,
      ticketId,
    }
  }, 3_000_000)

  it('a missing pullRequestTo branch blocks with no pull request', async () => {
    phase2At = new Date().toISOString()
    const branchesBefore = ((await owner(['repos/' + REPO + '/branches?per_page=100'])) as { name: string }[]).map(
      branch => branch.name,
    )
    await start(MISSING)

    const issue2 = await createIssue(BLOCK_TITLE, BLOCK_BODY + RUN_MARKER)
    issues.push(issue2.number)
    issue2Number = issue2.number
    const trigger = await until(() => triggerOfIssue(issue2.number), 300_000, 5_000, 'trigger for the blocked issue')
    const t2 = await until(
      () => storeRows<Ticket>('ticket').find(ticket => ticket.origin.triggerId === trigger.id)?.id,
      300_000,
      5_000,
      'ticket for the blocked issue',
    )
    ticketId = t2

    const state = await until(
      async () => {
        const ticket = ticketById(t2)
        if (!ticket) return undefined
        const latest = ticket.assignments.at(-1)?.report?.state
        if (latest === 'ready') throw new Error(`ticket ${t2} reported ready with a missing pullRequestTo branch`)
        const pulls = await agentPullsSince(phase2At)
        if (pulls.length > 0) throw new Error(`agent pull request opened for the missing pullRequestTo branch`)
        return latest === 'blocked' ? latest : undefined
      },
      600_000,
      10_000,
      'ticket blocked',
    )
    const report = ticketById(t2)!.assignments.at(-1)!.report!
    summary = report.summary
    expect(summary).toContain(MISSING)
    expect(summary).toMatch(/A person must/)

    expect(existsSync(join(dir, 'state', 'worktrees', t2))).toBe(false)
    expect(existsSync(join(dir, 'state', 'branches', t2 + '.json'))).toBe(false)

    const pulls = await agentPullsSince(phase2At)
    expect(pulls).toHaveLength(0)
    const branchesAfter = ((await owner(['repos/' + REPO + '/branches?per_page=100'])) as { name: string }[]).map(
      branch => branch.name,
    )
    const newAgentBranches = branchesAfter.filter(name => AGENT_BRANCH.test(name) && !branchesBefore.includes(name))
    expect(newAgentBranches).toEqual([])

    evidence.blocked = {
      issue: issue2.html_url,
      issueBody: BLOCK_BODY + RUN_MARKER,
      ticketId: t2,
      state,
      summary,
      pulls: pulls.length,
      newAgentBranches,
    }
  }, 900_000)

  it('the host posts the blocked reason once', async () => {
    const expected = workspaceBlockedText(summary)
    const listComments = async (): Promise<Comment[]> =>
      (await owner(['repos/' + REPO + '/issues/' + issue2Number + '/comments?per_page=100'])) as Comment[]
    let all: Comment[] = []
    try {
      await until(
        async () => {
          all = await listComments()
          return all.length > 0 ? true : undefined
        },
        600_000,
        15_000,
        'reason comment on the blocked issue',
      )
      await sleep(90_000)
      all = await listComments()

      expect(all).toHaveLength(1)
      expect(all[0]!.user.login).toBe(AGENT)
      const body = stripMarker(all[0]!.body)
      expect(body).toBe(expected)
      expect(body).toContain(MISSING)
      expect(body.startsWith('I could not start this task. ')).toBe(true)
      expect(body.endsWith(' Reply here once that is fixed to try again.')).toBe(true)
      expect(all.some(comment => /accept/i.test(comment.body))).toBe(false)

      evidence.blockedComment = {
        url: all[0]!.html_url,
        author: all[0]!.user.login,
        body,
        expectedMatch: body === expected,
      }
    } finally {
      evidence.issue2Comments = all.map(comment => ({
        url: comment.html_url,
        author: comment.user.login,
        body: comment.body,
        created_at: comment.created_at,
      }))
    }
  }, 900_000)

  it('this run publishes no milestone ids, milestone words or AI attribution', async () => {
    const texts: [string, string][] = []
    for (const n of issues) {
      const issue = (await owner(['repos/' + REPO + '/issues/' + n])) as Issue
      texts.push(['issue #' + n + ' title', issue.title], ['issue #' + n + ' body', issue.body ?? ''])
      const comments = (await owner(['repos/' + REPO + '/issues/' + n + '/comments?per_page=100'])) as Comment[]
      for (const comment of comments) texts.push(['issue #' + n + ' comment ' + comment.id, comment.body])
    }
    for (const pull of await agentPullsSince(startedAt)) {
      texts.push(
        ['pull #' + pull.number + ' title', pull.title],
        ['pull #' + pull.number + ' body', pull.body ?? ''],
        ['pull #' + pull.number + ' head', pull.head.ref],
      )
      for (const commit of await commitsOf(pull.number))
        texts.push(['pull #' + pull.number + ' commit ' + commit.sha.slice(0, 7), commit.commit.message])
    }
    const problems = texts.flatMap(([label, value]) => [
      ...contentProblems(label, value),
      ...attributionProblems(label, value),
    ])
    evidence.content = { scanned: texts.length, problems, contacted: [REPO] }
    expect(problems).toEqual([])
  }, 300_000)

  afterAll(async () => {
    if (!dir) return
    try {
      if (running) await stop()

      const state = join(dir, 'state')
      const files = existsSync(state) ? walk(state) : []
      const fileHits = files.filter(file => {
        const buffer = readFileSync(file)
        return TOKENS.some(token => buffer.includes(token))
      }).length
      const lineHits = [...lines.map(line => JSON.stringify(line)), ...errs].filter(text =>
        TOKENS.some(token => text.includes(token)),
      ).length
      scanned = true
      evidence.tokenScan = { files: fileHits, captured: lineHits }

      const openPulls = (await agentPullsSince(startedAt)).filter(pull => pull.state === 'open')
      for (const pull of openPulls) {
        await attempt('close pull #' + pull.number, async () => {
          await owner(['repos/' + REPO + '/pulls/' + pull.number, '-X', 'PATCH', '-f', 'state=closed'])
          cleanup.closedPulls.push(pull.number)
        })
        if (AGENT_BRANCH.test(pull.head.ref))
          await attempt('delete branch ' + pull.head.ref, async () => {
            await owner(['repos/' + REPO + '/git/refs/heads/' + pull.head.ref, '-X', 'DELETE'])
            cleanup.deletedBranches.push(pull.head.ref)
          })
      }
      for (const n of issues) {
        await attempt('close issue #' + n, async () => {
          await owner([
            'repos/' + REPO + '/issues/' + n,
            '-X',
            'PATCH',
            '-f',
            'state=closed',
            '-f',
            'state_reason=not_planned',
          ])
          cleanup.closedIssues.push(n)
        })
      }
      await attempt('list remaining', async () => {
        const openIssues = (await owner(['repos/' + REPO + '/issues?state=open&per_page=100'])) as Issue[]
        cleanup.remaining.issues = openIssues
          .filter(item => !item.pull_request && issues.includes(item.number))
          .map(item => item.number)
        cleanup.remaining.pulls = (await agentPullsSince(startedAt))
          .filter(pull => pull.state === 'open')
          .map(pull => pull.number)
      })
      evidence.cleanup = cleanup

      const serialized = JSON.stringify({ evidence, configs: { phase1: configFor(DEV), phase2: configFor(MISSING) } })
      const jsonl = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
      const leaked =
        fileHits > 0 || lineHits > 0 || TOKENS.some(token => serialized.includes(token) || jsonl.includes(token))

      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(join(OUT_DIR, 'branch-config.md'), renderRecord(evidence) + '\n')
      expect(leaked).toBe(false)

      const stem = `branch-config-${stamp(new Date(startedAt))}`
      const rawDir = join(OUT_DIR, 'raw')
      mkdirSync(rawDir, { recursive: true })
      writeFileSync(
        join(rawDir, stem + '.json'),
        JSON.stringify(
          {
            configs: { phase1: configFor(DEV), phase2: configFor(MISSING) },
            limits: LIMITS,
            startedAt,
            phase2At,
            warnings: errs,
            ...evidence,
          },
          null,
          2,
        ),
      )
      writeFileSync(join(rawDir, stem + '.jsonl'), jsonl)
    } finally {
      if (failed && scanned) {
        const kept = join(OUT_DIR, 'raw', `branch-config-failed-${stamp(new Date(startedAt))}`)
        mkdirSync(kept, { recursive: true })
        for (const name of readdirSync(join(dir, 'state')).filter(name => name.startsWith(DATABASE_FILE)))
          copyFileSync(join(dir, 'state', name), join(kept, name))
        writeFileSync(join(kept, 'log.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
        console.log(`[LIVE-KEPT] ${kept}`)
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
