/**
 * Live PR delivery run against the playground repository: the daemon started through the CLI in auto mode with subscription OAuth, an owner issue becomes one pull request by the agent account, and a follow-up PR comment adds a commit in the same ticket, worktree and session. Evidence is read from the store, GitHub and the logs. Gated by SUPERAGENT_CLAUDE_LIVE=1 and the three tokens; never prints a token; the PR body closes the issue, `status` shows the idle session as idle, and the follow-up result goes to the PR, not the issue.
 */
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Ticket, Trigger } from '../../src/core/index.ts'
import { main } from '../../src/cli/main.ts'
import { DATABASE_FILE, databasePath, type Receipt } from '../../src/app/store.ts'
import { openReadOnly } from '../../src/app/store-read.ts'
import { sleep } from '../fixtures/async.ts'
import { ghJson } from './gh.ts'
import { assertAllowedRepo } from './guard.ts'

const LIVE = process.env.SUPERAGENT_CLAUDE_LIVE === '1'
const AGENT_TOKEN = process.env.SUPERAGENT_CLAUDE_GITHUB_TOKEN?.trim()
const OWNER_TOKEN = process.env.SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN?.trim()
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
const REPO = assertAllowedRepo('ok0/superagent-claude-playground')
const AGENT = 'ok0-worker'
const OWNER = 'ok0'
const LIMITS = { max: 1, maxTurns: 60, maxBudgetUsd: 3 }
const MARKER = /<!--\s*superagent-claude:(.+?)\s*-->/
const STRIP = /<!--\s*superagent-claude:.*?-->/g
const ISSUE_TITLE = 'Add a USAGE file'
const ISSUE_BODY = '@ok0-worker Please add a file named USAGE.md with one sentence saying this repository is a playground for automated agent tests, and open a pull request with the change.'
const FOLLOW_UP = 'Please also add a second sentence to USAGE.md saying the file is kept up to date by the automation.'

type Line = Record<string, unknown>
interface Comment { id: number; body: string; html_url: string; created_at: string; user: { login: string } }
interface Pull { number: number; html_url: string; title: string; body?: string | null; created_at: string; head: { ref: string }; user: { login: string } }
interface Commit { sha: string; html_url: string; commit: { message: string } }

const evidence: Record<string, unknown> = {}
const TOKENS = [AGENT_TOKEN, OWNER_TOKEN, OAUTH].filter((token): token is string => Boolean(token))

async function owner(args: string[]): Promise<unknown> {
  return await ghJson(OWNER_TOKEN!, args)
}

async function createIssue(title: string, body: string): Promise<{ number: number; html_url: string }> {
  return await owner(['repos/' + REPO + '/issues', '-X', 'POST', '-f', 'title=' + title, '-f', 'body=' + body]) as { number: number; html_url: string }
}

async function addComment(n: number, body: string): Promise<{ id: number; html_url: string; created_at: string }> {
  return await owner(['repos/' + REPO + '/issues/' + n + '/comments', '-X', 'POST', '-f', 'body=' + body]) as { id: number; html_url: string; created_at: string }
}

async function agentComments(n: number): Promise<Comment[]> {
  const all = await owner(['repos/' + REPO + '/issues/' + n + '/comments?per_page=100']) as Comment[]
  return all.filter(comment => comment.user.login === AGENT)
}

async function agentPulls(): Promise<Pull[]> {
  const all = await owner(['repos/' + REPO + '/pulls?state=all&per_page=100']) as Pull[]
  return all.filter(pull => pull.user.login === AGENT)
}

async function commitsOf(pr: number): Promise<Commit[]> {
  return await owner(['repos/' + REPO + '/pulls/' + pr + '/commits?per_page=100']) as Commit[]
}

async function until<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number, stepMs = 15_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error('timed out: ' + label)
    await sleep(stepMs)
  }
}

function markerId(body: string): string {
  const match = MARKER.exec(body)
  if (!match) throw new Error('no superagent-claude marker in comment')
  return match[1]!
}

function stripMarker(body: string): string {
  return body.replace(STRIP, '').trim()
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

describe.skipIf(!LIVE || !AGENT_TOKEN || !OWNER_TOKEN || !OAUTH)('live pr delivery', () => {
  let dir = ''
  let configPath = ''
  let config: Record<string, unknown> = {}
  let startedAt = ''
  const lines: Line[] = []
  const errs: string[] = []
  const signals = new EventEmitter()
  let exitCode: number | undefined
  let done: Promise<number> = Promise.resolve(-1)
  let failed = false
  let scanned = false
  let ticketId = ''
  let prNumber = 0
  afterEach(ctx => { if (ctx.task.result?.state === 'fail') failed = true })

  const statusText = async (): Promise<string> => {
    const out: string[] = []
    const code = await main(['status', '--config', configPath], { out: s => { out.push(s) }, err: () => {}, cwd: dir, env: process.env, signals: new EventEmitter() })
    expect(code).toBe(0)
    return out.join('')
  }
  const idleShown = async (): Promise<string | undefined> => {
    const text = await statusText()
    return text.includes('Idle sessions (1):') && text.includes(ticketId) && text.includes('Running assignments: none') ? text : undefined
  }
  const closing = (n: number): RegExp => new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:#|${REPO}#|https://github\.com/${REPO}/issues/)${n}(?![0-9])`, 'i')
  const replyIds = (): Set<string> => new Set(storeRows<Receipt>('outbox').filter(r => r.ticketId === ticketId && r.kind === 'reply' && r.status === 'sent').map(r => r.id))

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
  const triggerOfComment = (commentId: number): Trigger | undefined =>
    storeRows<Trigger>('trigger').find(trigger => trigger.meta.commentId === commentId && trigger.meta.repository === REPO)
  const triggerOfIssue = (n: number): Trigger | undefined =>
    storeRows<Trigger>('trigger').find(trigger => trigger.meta.kind === 'issue' && trigger.meta.number === n && trigger.meta.repository === REPO)
  const ticketById = (id: string): Ticket | undefined => storeRows<Ticket>('ticket').find(ticket => ticket.id === id)
  const count = (event: string, ticketIdFilter?: string): number =>
    lines.filter(line => line.event === event && (ticketIdFilter === undefined || line.ticketId === ticketIdFilter)).length
  const assertLimits = (id: string): Record<string, unknown> => {
    const [worker] = storeQuery('SELECT * FROM worker WHERE ticket_id = ?', id)
    expect(worker).toBeDefined()
    expect(worker!.cwd).toBe(join(dir, 'state', 'worktrees', id))
    expect(worker!.session_id).not.toBeNull()
    expect(Number(worker!.turns)).toBeGreaterThan(0)
    expect(Number(worker!.turns)).toBeLessThanOrEqual(LIMITS.maxTurns)
    expect(Number(worker!.cost_usd)).toBeGreaterThan(0)
    expect(Number(worker!.cost_usd)).toBeLessThanOrEqual(LIMITS.maxBudgetUsd)
    const ticket = ticketById(id)
    const reports = (ticket?.assignments ?? []).map(assignment => assignment.report?.summary ?? '')
    expect(reports.some(summary => summary === 'turn limit' || summary === 'budget limit')).toBe(false)
    return { assignment: worker!.assignment_id, session: worker!.session_id, turns: worker!.turns, costUsd: worker!.cost_usd, cwd: worker!.cwd, branch: worker!.branch }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sac-live-pr-'))
    configPath = join(dir, 'superagent-claude.json')
    config = { repositories: [REPO], policy: { allowed: [OWNER], acceptMode: 'auto' }, auth: { mode: 'subscription', owner: OWNER }, delivery: { allowAutoMerge: false }, workers: LIMITS, stateDir: join(dir, 'state') }
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
  }, 120_000)

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

      const projects = join(state, 'claude', 'projects')
      const transcriptFiles = files.filter(file => file.startsWith(projects + sep) && file.endsWith('.jsonl'))
      const routerTools = new Set<string>()
      const workerPermissionModes = new Set<string>()
      for (const file of transcriptFiles) {
        for (const text of readFileSync(file, 'utf8').split('\n')) {
          if (!text.trim()) continue
          const entry = JSON.parse(text) as { cwd?: string; permissionMode?: string; message?: { content?: unknown } }
          if (entry.cwd === join(state, 'router')) {
            const content = Array.isArray(entry.message?.content) ? entry.message.content as { type?: string; name?: string }[] : []
            for (const block of content) if (block.type === 'tool_use' && block.name) routerTools.add(block.name)
          } else if (entry.cwd?.startsWith(join(state, 'worktrees') + sep)) {
            if (entry.permissionMode) workerPermissionModes.add(entry.permissionMode)
          }
        }
      }
      const badRouterTools = [...routerTools].filter(name => !name.startsWith('mcp__superagent__'))
      expect(badRouterTools).toEqual([])
      expect(workerPermissionModes.has('bypassPermissions')).toBe(false)
      evidence.transcripts = { transcripts: transcriptFiles.length, routerTools: [...routerTools].sort(), workerPermissionModes: [...workerPermissionModes].sort() }

      const serialized = JSON.stringify({ evidence, config, limits: LIMITS, startedAt, warnings: errs })
      const jsonl = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
      expect(TOKENS.some(token => serialized.includes(token) || jsonl.includes(token))).toBe(false)
      const stem = `pr-delivery-${stamp(new Date(startedAt))}`
      const outDir = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, stem + '.json'), JSON.stringify({ config, limits: LIMITS, startedAt, warnings: errs, ...evidence }, null, 2))
      writeFileSync(join(outDir, stem + '.jsonl'), jsonl)
    } finally {
      if (failed && scanned) {
        const kept = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw', `pr-delivery-failed-${stamp(new Date(startedAt))}`)
        mkdirSync(kept, { recursive: true })
        for (const name of readdirSync(join(dir, 'state')).filter(name => name.startsWith(DATABASE_FILE))) copyFileSync(join(dir, 'state', name), join(kept, name))
        writeFileSync(join(kept, 'log.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
        console.log(`[LIVE-KEPT] ${kept}`)
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('an issue becomes one PR and a PR comment adds a commit in the same ticket, worktree and session', async () => {
    const t0 = Date.now()
    const issue = await createIssue(ISSUE_TITLE, ISSUE_BODY)
    const issueTrigger = await until(() => triggerOfIssue(issue.number), 300_000, 5_000, 'trigger for the issue')
    ticketId = await until(() => storeRows<Ticket>('ticket').find(ticket => ticket.origin.triggerId === issueTrigger.id)?.id, 300_000, 5_000, 'ticket for the issue')

    const pull = await until(async () => {
      const ticket = ticketById(ticketId)
      if (!ticket) return undefined
      const latest = ticket.assignments.at(-1)?.report?.state
      if (ticket.ended || latest === 'failed' || latest === 'blocked') throw new Error(`ticket ${ticketId} ended or reported ${String(latest)} before a PR was opened`)
      const pulls = (await agentPulls()).filter(item => Date.parse(item.created_at) >= Date.parse(startedAt))
      return pulls.find(item => item.head.ref.startsWith('agent/') && ticket.follows?.some(follow => follow.own && follow.thread.toLowerCase() === ('github:' + REPO + '#' + item.number).toLowerCase()))
    }, 900_000, 20_000, 'PR opened by the agent for the ticket')
    prNumber = pull.number
    const branch = pull.head.ref
    expect(pull.body ?? '').toMatch(closing(issue.number))
    expect(((pull.body ?? '').match(new RegExp(`Closes #${issue.number}(?![0-9])`, 'g')) ?? []).length).toBeLessThanOrEqual(1)
    await until(async () => {
      const r = await owner(['graphql', '-f', `query=query { repository(owner: "ok0", name: "superagent-claude-playground") { pullRequest(number: ${prNumber}) { closingIssuesReferences(first: 10) { nodes { number } } } } }`]) as { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: { number: number }[] } } } } }
      return r.data.repository.pullRequest.closingIssuesReferences.nodes.some(n => n.number === issue.number) ? true : undefined
    }, 120_000, 10_000, 'PR closes the issue')

    const idleBefore = await until(idleShown, 900_000, 10_000, 'status shows the idle session before the follow-up')
    await until(() => Number(storeQuery('SELECT turns FROM worker WHERE ticket_id = ?', ticketId)[0]?.turns ?? 0) > 0 ? true : undefined, 120_000, 5_000, 'worker turn persisted')
    const workerBefore = assertLimits(ticketId)
    const c1 = (await commitsOf(prNumber)).length
    const head1 = (await commitsOf(prNumber)).at(-1)?.sha
    const session1 = workerBefore.session
    const cwd1 = workerBefore.cwd

    const firstOnIssue = await until(async () => { const ids = replyIds(); return (await agentComments(issue.number)).find(c => ids.has(MARKER.exec(c.body)?.[1] ?? '')) }, 300_000, 15_000, 'first result reply on the issue')
    const comment = await addComment(prNumber, FOLLOW_UP)
    const commentTrigger = await until(() => triggerOfComment(comment.id), 300_000, 15_000, 'trigger for the PR comment')
    await until(async () => (await commitsOf(prNumber)).length > c1 ? true : undefined, 720_000, 20_000, 'follow-up commit on the PR')
    const prReply = await until(async () => { const ids = replyIds(); return (await agentComments(prNumber)).find(c => Date.parse(c.created_at) > Date.parse(comment.created_at) && ids.has(MARKER.exec(c.body)?.[1] ?? '')) }, 900_000, 20_000, 'follow-up result reply on the PR')
    const idleAfter = await until(idleShown, 900_000, 10_000, 'status shows the idle session after the follow-up')
    const issueAfter = (await agentComments(issue.number)).filter(c => Date.parse(c.created_at) > Date.parse(comment.created_at))
    expect(issueAfter).toHaveLength(0)

    const tickets = storeRows<Ticket>('ticket')
    expect(tickets).toHaveLength(1)
    const disposition = storeQuery('SELECT value FROM disposition WHERE id = ?', commentTrigger.id)[0]
    expect(disposition).toBeDefined()
    const parsed = JSON.parse(String(disposition!.value)) as { evalId?: string; fanout?: string[] }
    expect(parsed.evalId).toBeUndefined()
    expect(parsed.fanout).toContain(ticketId)
    const decisionRows = storeRows<{ triggerIds: string[] }>('decision')
    expect(decisionRows.filter(decision => decision.triggerIds.includes(commentTrigger.id))).toHaveLength(0)

    const workerAfter = assertLimits(ticketId)
    expect(workerAfter.cwd).toBe(cwd1)
    expect(workerAfter.branch).toBe(branch)
    expect(workerAfter.session).toBe(session1)
    const pullNow = (await owner(['repos/' + REPO + '/pulls/' + prNumber])) as Pull
    expect(pullNow.head.ref).toBe(branch)
    expect((await agentPulls()).filter(item => Date.parse(item.created_at) >= Date.parse(startedAt))).toHaveLength(1)

    const receipts = storeRows<Receipt>('outbox').filter(row => row.ticketId === ticketId)
    const receiptIds = receipts.map(row => row.id)
    expect(new Set(receiptIds).size).toBe(receiptIds.length)
    expect(receipts.every(row => row.status === 'sent')).toBe(true)

    const c2 = (await commitsOf(prNumber)).length
    const head2 = (await commitsOf(prNumber)).at(-1)?.sha
    const agents = await agentComments(prNumber)
    evidence.pr = {
      issue: issue.html_url,
      pr: pull.html_url,
      comment: comment.html_url,
      commits: { before: c1, after: c2, headBefore: head1, headAfter: head2 },
      commitUrls: (await commitsOf(prNumber)).map(commit => commit.html_url),
      agentReplies: agents.map(item => ({ url: item.html_url, id: markerId(item.body) })),
      ticketId,
      timeline: lines.filter(line => line.ticketId === ticketId).map(line => [line.at, line.event]),
      worker: { before: workerBefore, after: workerAfter, sameSession: workerAfter.session === session1 },
      trigger: { comment: commentTrigger.id, evalId: parsed.evalId ?? null, fanout: parsed.fanout },
      receipts: receipts.map(row => ({ id: row.id, kind: row.kind, status: row.status })),
      evalCount: count('eval.started'),
      durationMs: Date.now() - t0,
      followUp: {
        firstResultOnIssue: firstOnIssue.html_url,
        resultOnPr: prReply.html_url,
        newAgentCommentsOnIssue: issueAfter.length,
        prBodyCloses: true,
        idleBefore: idleBefore.split('\n').filter(l => l.includes(ticketId)),
        idleAfter: idleAfter.split('\n').filter(l => l.includes(ticketId)),
      },
    }
    console.log(`[PR] issue=${issue.html_url} pr=${pull.html_url} comment=${comment.html_url} ticket=${ticketId} sameSession=${String(workerAfter.session === session1)} commits=${c1}->${c2}`)
    console.log(`[PR] turns=${String(workerAfter.turns)} costUsd=${String(workerAfter.costUsd)} evalCount=${count('eval.started')} receipts=${receipts.length}`)
    console.log(`[FOLLOW-UP] resultOnPr=${prReply.html_url} newAgentCommentsOnIssue=${issueAfter.length} idleBefore=true idleAfter=true closes=#${issue.number}`)
  }, 3_000_000)

  it('no live content in the repository names a milestone', async () => {
    const queried: string[] = []
    const get = async <T>(path: string): Promise<T> => { queried.push(path); return await owner([path]) as T }
    const issues = await get<{ title: string; body?: string | null }[]>('repos/' + REPO + '/issues?state=all&per_page=100')
    const issueComments = await get<{ body?: string | null }[]>('repos/' + REPO + '/issues/comments?per_page=100')
    const pulls = await get<{ number: number; title: string; body?: string | null; head: { ref: string } }[]>('repos/' + REPO + '/pulls?state=all&per_page=100')
    const reviewComments = await get<{ body?: string | null }[]>('repos/' + REPO + '/pulls/comments?per_page=100')
    const commitMessages: string[] = []
    for (const pull of pulls) {
      const commits = await get<Commit[]>('repos/' + REPO + '/pulls/' + pull.number + '/commits?per_page=100')
      commitMessages.push(...commits.map(commit => commit.commit.message))
    }
    const branches = await get<{ name: string }[]>('repos/' + REPO + '/branches?per_page=100')
    const texts = [
      ...issues.flatMap(issue => [issue.title, issue.body ?? '']),
      ...issueComments.map(comment => comment.body ?? ''),
      ...pulls.flatMap(pull => [pull.title, pull.body ?? '', pull.head.ref]),
      ...reviewComments.map(comment => comment.body ?? ''),
      ...commitMessages,
      ...branches.map(branch => branch.name),
    ]
    const matches = texts.filter(text => /\bM\d+\b|milestone/i.test(text))
    const branding = { queried, results: { issues: issues.length, issueComments: issueComments.length, pulls: pulls.length, reviewComments: reviewComments.length, commits: commitMessages.length, branches: branches.length }, scanned: texts.length, matches: matches.length }
    evidence.branding = branding
    console.log(`[LIVE-TEXT] scanned=${branding.scanned} matches=${branding.matches} queried=${queried.length}`)
    expect(matches).toHaveLength(0)
  }, 300_000)
})
