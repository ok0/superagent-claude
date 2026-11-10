/**
 * Live delivery on a repository the agent account cannot write: the daemon started through the CLI in auto mode with subscription OAuth, an owner issue becomes a ticket with an acknowledgement and a worktree, publish returns published: false without any push or pull request, and the worker reports blocked with a question for a person. An event from an unlisted repository is not admitted. Evidence is read from the store, GitHub, the transcripts and the logs. Gated by SUPERAGENT_CLAUDE_LIVE=1 and the three tokens; never prints a token.
 */
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Ticket, Trigger } from '../../src/core/index.ts'
import { main } from '../../src/cli/main.ts'
import { DATABASE_FILE, databasePath, type Receipt } from '../../src/app/store.ts'
import { openReadOnly } from '../../src/app/store-read.ts'
import { humanTextProblem } from '../../src/app/tools/tool.ts'
import { WRITE_ACCESS_NOTE_LEAD } from '../../src/app/prompts.ts'
import { sleep } from '../fixtures/async.ts'

const execFileAsync = promisify(execFile)
const LIVE = process.env.SUPERAGENT_CLAUDE_LIVE === '1'
const AGENT_TOKEN = process.env.SUPERAGENT_CLAUDE_GITHUB_TOKEN?.trim()
const OWNER_TOKEN = process.env.SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN?.trim()
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
const REPO = 'ok0/superagent-claude-playground-readonly'
const OUTSIDE = 'ok0/superagent-claude-playground'
const AGENT = 'ok0-worker'
const OWNER = 'ok0'
const LIMITS = { max: 1, maxTurns: 40, maxBudgetUsd: 2 }
const MARKER = /<!--\s*superagent-claude:(.+?)\s*-->/
const STRIP = /<!--\s*superagent-claude:.*?-->/g
const ISSUE_TITLE = 'Add a USAGE file'
const ISSUE_BODY = '@ok0-worker Please add a file named USAGE.md with one sentence saying this repository is a test target for automated agent runs, and open a pull request with the change.'
const OUTSIDE_TITLE = 'Check the readme'
const OUTSIDE_BODY = '@ok0-worker Please add one line to the readme.'

type Line = Record<string, unknown>
interface Comment { id: number; body?: string | null; html_url: string; created_at: string; user: { login: string } }
interface Pull { number: number; html_url: string; title: string; body?: string | null; created_at: string; head: { ref: string }; user: { login: string } }
interface Commit { sha: string; html_url: string; commit: { message: string } }
interface Invitation { invitee: { login: string } | null }

const evidence: Record<string, unknown> = {}
const TOKENS = [AGENT_TOKEN, OWNER_TOKEN, OAUTH].filter((token): token is string => Boolean(token))

async function owner(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', ...args], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GH_TOKEN: OWNER_TOKEN! } })
    return JSON.parse(stdout)
  } catch {
    throw new Error('gh api failed: ' + args[0])
  }
}

async function ownerStatus(path: string): Promise<number> {
  try {
    await execFileAsync('gh', ['api', path, '--silent'], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GH_TOKEN: OWNER_TOKEN! } })
    return 200
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '')
    return Number(/HTTP (\d{3})/.exec(stderr)?.[1]) || 0
  }
}

async function createIssue(repo: string, title: string, body: string): Promise<{ number: number; html_url: string }> {
  return await owner(['repos/' + repo + '/issues', '-X', 'POST', '-f', 'title=' + title, '-f', 'body=' + body]) as { number: number; html_url: string }
}

async function closeIssue(repo: string, n: number): Promise<void> {
  await owner(['repos/' + repo + '/issues/' + n, '-X', 'PATCH', '-f', 'state=closed'])
}

async function agentComments(n: number): Promise<Comment[]> {
  const all = await owner(['repos/' + REPO + '/issues/' + n + '/comments?per_page=100']) as Comment[]
  return all.filter(comment => comment.user.login === AGENT)
}

async function agentPulls(): Promise<Pull[]> {
  const all = await owner(['repos/' + REPO + '/pulls?state=all&per_page=100']) as Pull[]
  return all.filter(pull => pull.user.login === AGENT)
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

describe.skipIf(!LIVE || !AGENT_TOKEN || !OWNER_TOKEN || !OAUTH)('live delivery without write access', () => {
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
  let outsideIssue: { number: number; html_url: string } | undefined
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
  const triggerOfIssue = (repo: string, n: number): Trigger | undefined =>
    storeRows<Trigger>('trigger').find(trigger => trigger.meta.kind === 'issue' && trigger.meta.number === n && trigger.meta.repository === repo)
  const ticketById = (id: string): Ticket | undefined => storeRows<Ticket>('ticket').find(ticket => ticket.id === id)

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sac-live-readonly-'))
    configPath = join(dir, 'superagent-claude.json')

    const status = await ownerStatus('repos/' + REPO)
    if (status !== 200) throw new Error('the readonly test repository must already exist (HTTP ' + status + ')')
    const repo = await owner(['repos/' + REPO]) as { html_url: string; private: boolean }
    expect(repo.private).toBe(false)
    const collaboratorStatus = await ownerStatus('repos/' + REPO + '/collaborators/' + AGENT)
    if (collaboratorStatus === 204) throw new Error('agent is a collaborator of the readonly repository')
    expect(collaboratorStatus).toBe(404)
    const invitations = await owner(['repos/' + REPO + '/invitations']) as Invitation[]
    const invited = invitations.some(invitation => invitation.invitee?.login === AGENT)
    expect(invited).toBe(false)
    evidence.repository = { url: repo.html_url, private: repo.private, collaboratorStatus, invited }

    config = { repositories: [REPO], policy: { allowed: [OWNER], acceptMode: 'auto' }, auth: { mode: 'subscription', owner: OWNER }, workers: LIMITS, stateDir: join(dir, 'state') }
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
    const access = await until(() => {
      if (exitCode !== undefined) throw new Error(errs.join(''))
      return lines.find(line => line.event === 'github.repository_access' && line.repository === REPO)
    }, 120_000, 1000, 'repository access check')
    expect(access.accessible).toBe(true)
    expect(access.push).toBe(false)
    const [kv] = storeQuery('SELECT value FROM kv WHERE key = ?', 'repo-access:' + REPO)
    expect(kv).toBeDefined()
    const recorded = JSON.parse(String(kv!.value)) as { accessible: boolean; push: boolean }
    expect(recorded.push).toBe(false)
    evidence.startupAccess = { log: { accessible: access.accessible, push: access.push }, kv: { accessible: recorded.accessible, push: recorded.push } }
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
      const stem = `readonly-delivery-${stamp(new Date(startedAt))}`
      const outDir = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, stem + '.json'), JSON.stringify({ config, limits: LIMITS, startedAt, warnings: errs, ...evidence }, null, 2))
      writeFileSync(join(outDir, stem + '.jsonl'), jsonl)
    } finally {
      if (failed && scanned) {
        const kept = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw', `readonly-delivery-failed-${stamp(new Date(startedAt))}`)
        mkdirSync(kept, { recursive: true })
        for (const name of readdirSync(join(dir, 'state')).filter(name => name.startsWith(DATABASE_FILE))) copyFileSync(join(dir, 'state', name), join(kept, name))
        writeFileSync(join(kept, 'log.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
        console.log(`[LIVE-KEPT] ${kept}`)
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)

  it('a code request without write access is acknowledged without a pull request promise and blocked asking for write access before any work', async () => {
    const t0 = Date.now()
    const issue = await createIssue(REPO, ISSUE_TITLE, ISSUE_BODY)
    const issueTrigger = await until(() => triggerOfIssue(REPO, issue.number), 300_000, 5_000, 'trigger for the issue')
    ticketId = await until(() => storeRows<Ticket>('ticket').find(ticket => ticket.origin.triggerId === issueTrigger.id)?.id, 300_000, 5_000, 'ticket for the issue')

    const blocked = await until(() => {
      const ticket = ticketById(ticketId)
      if (!ticket) return undefined
      const latest = ticket.assignments.at(-1)?.report?.state
      if (latest === 'failed' || latest === 'ready') throw new Error(`ticket ${ticketId} reported ${latest} instead of blocked`)
      if (ticket.ended) throw new Error(`ticket ${ticketId} ended before it was reported blocked`)
      return latest === 'blocked' ? ticket : undefined
    }, 900_000, 20_000, 'blocked report for the ticket')

    const [worker] = storeQuery('SELECT * FROM worker WHERE ticket_id = ?', ticketId)
    expect(worker).toBeDefined()
    expect(worker!.cwd).toBe(join(dir, 'state', 'worktrees', ticketId))
    expect(existsSync(join(worker!.cwd as string, '.git'))).toBe(true)

    const transcriptFiles = walk(join(dir, 'state', 'claude', 'projects')).filter(file => file.endsWith('.jsonl'))
    const publishResults = transcriptFiles.flatMap(file => readFileSync(file, 'utf8').split('\n').filter(text => text.trim()))
      .filter(text => /published\\?"\s*:\s*false|published: false/.test(text) && text.includes(REPO))
    const publishCalls = publishResults.length
    const publishResult = publishResults[0]?.slice(0, 2000) ?? null

    const question = blocked.attention?.question ?? ''
    expect(question.length).toBeGreaterThan(0)
    expect(humanTextProblem(question)).toBeUndefined()

    await until(() => storeRows<Receipt>('outbox').some(row => row.ticketId === ticketId && row.kind !== 'acknowledgement' && row.status === 'sent') ? true : undefined, 600_000, 20_000, 'non-acknowledgement reply receipt sent')
    const comments = await agentComments(issue.number)

    const noteSeen = transcriptFiles.some(file => readFileSync(file, 'utf8').includes(WRITE_ACCESS_NOTE_LEAD + ' ' + REPO))
    expect(noteSeen).toBe(true)
    expect(/write access|permission/i.test(question)).toBe(true)

    const branches = await owner(['repos/' + REPO + '/branches?per_page=100']) as { name: string }[]
    expect(branches.filter(branch => branch.name.startsWith('agent/'))).toHaveLength(0)
    const pulls = (await agentPulls()).filter(pull => Date.parse(pull.created_at) >= Date.parse(startedAt))
    expect(pulls).toHaveLength(0)

    const receipts = storeRows<Receipt>('outbox').filter(row => row.ticketId === ticketId)
    expect(receipts.every(row => row.status === 'sent')).toBe(true)

    const health = storeQuery('SELECT value FROM kv WHERE key = ?', 'health')[0]
    const snapshot = health ? JSON.parse(String(health.value)) as { entries?: Record<string, { state?: string }> } : undefined
    expect(snapshot?.entries?.['github:' + REPO]?.state).not.toBe('error')

    const acks = receipts.filter(row => row.kind === 'acknowledgement').map(row => row.text)
    expect(acks.every(text => !/pull request|\bPR\b|merge/i.test(text))).toBe(true)

    const worktreesRoot = join(dir, 'state', 'worktrees') + sep
    const writes = transcriptFiles.flatMap(file => readFileSync(file, 'utf8').split('\n').filter(text => text.trim()).map(text => JSON.parse(text) as { cwd?: string; message?: { content?: unknown } }))
      .filter(entry => entry.cwd?.startsWith(worktreesRoot))
      .flatMap(entry => Array.isArray(entry.message?.content) ? entry.message.content as { type?: string; name?: string }[] : [])
      .filter(block => block.type === 'tool_use' && ['Write', 'Edit', 'NotebookEdit'].includes(block.name ?? '')).length
    expect(writes).toBe(0)

    evidence.readonly = {
      noteSeen,
      acks,
      writes,
      publishCalls,
      issue: issue.html_url,
      comments: comments.map(comment => ({ url: comment.html_url, id: markerId(comment.body ?? ''), body: stripMarker(comment.body ?? '') })),
      ticketId,
      timeline: lines.filter(line => line.ticketId === ticketId).map(line => [line.at, line.event]),
      report: { state: blocked.assignments.at(-1)?.report?.state, summary: blocked.assignments.at(-1)?.report?.summary, question },
      worker: { cwd: worker!.cwd, branch: worker!.branch, turns: worker!.turns, costUsd: worker!.cost_usd },
      publishResult,
      branches: branches.map(branch => branch.name),
      pulls: pulls.length,
      receipts: receipts.map(row => ({ id: row.id, kind: row.kind, status: row.status })),
      durationMs: Date.now() - t0,
    }
    console.log(`[READONLY] issue=${issue.html_url} ticket=${ticketId} comments=${comments.length} pulls=${pulls.length}`)
  }, 3_000_000)

  it('an event in an unlisted repository is not admitted', async () => {
    const issue = await createIssue(OUTSIDE, OUTSIDE_TITLE, OUTSIDE_BODY)
    outsideIssue = issue
    await sleep(200_000)

    const triggers = storeRows<Trigger>('trigger').filter(trigger => trigger.meta.repository === OUTSIDE)
    const outsideTicket = storeRows<Ticket>('ticket').find(ticket => {
      const trigger = storeRows<Trigger>('trigger').find(item => item.id === ticket.origin.triggerId)
      return trigger?.meta.repository === OUTSIDE
    })
    expect(outsideTicket).toBeUndefined()
    const outsideComments = await owner(['repos/' + OUTSIDE + '/issues/' + issue.number + '/comments?per_page=100']) as Comment[]
    expect(outsideComments.filter(comment => comment.user.login === AGENT)).toHaveLength(0)

    const rejected = storeQuery('SELECT trigger_id FROM rejected_trigger WHERE repository = ?', OUTSIDE)
    evidence.outside = { issue: issue.html_url, triggers: triggers.length, rejected: rejected.map(row => row.trigger_id), verdict: rejected.length ? 'rejected' : 'no inflow' }
    console.log(`[OUTSIDE] issue=${issue.html_url} triggers=${triggers.length} rejected=${rejected.length}`)
    await closeIssue(OUTSIDE, issue.number)
  }, 400_000)

  it('no live content names a milestone', async () => {
    const queried: string[] = []
    const get = async <T>(path: string): Promise<T> => { queried.push(path); return await owner([path]) as T }
    const repo = await get<{ description?: string | null }>('repos/' + REPO)
    const issues = await get<{ title: string; body?: string | null }[]>('repos/' + REPO + '/issues?state=all&per_page=100')
    const issueComments = await get<{ body?: string | null }[]>('repos/' + REPO + '/issues/comments?per_page=100')
    const pulls = await get<{ number: number; title: string; body?: string | null; head: { ref: string } }[]>('repos/' + REPO + '/pulls?state=all&per_page=100')
    const reviewComments = await get<{ body?: string | null }[]>('repos/' + REPO + '/pulls/comments?per_page=100')
    const commits = await get<{ commit: { message: string } }[]>('repos/' + REPO + '/commits?per_page=100')
    const branches = await get<{ name: string }[]>('repos/' + REPO + '/branches?per_page=100')
    const outsideIssues = outsideIssue ? await get<{ title: string; body?: string | null }>('repos/' + OUTSIDE + '/issues/' + outsideIssue.number) : undefined
    const outsideComments = outsideIssue ? await get<{ body?: string | null }[]>('repos/' + OUTSIDE + '/issues/' + outsideIssue.number + '/comments?per_page=100') : []
    const texts = [
      repo.description ?? '',
      ...issues.flatMap(issue => [issue.title, issue.body ?? '']),
      ...issueComments.map(comment => comment.body ?? ''),
      ...pulls.flatMap(pull => [pull.title, pull.body ?? '', pull.head.ref]),
      ...reviewComments.map(comment => comment.body ?? ''),
      ...commits.map(commit => commit.commit.message),
      ...branches.map(branch => branch.name),
      ...(outsideIssues ? [outsideIssues.title ?? '', outsideIssues.body ?? ''] : []),
      ...outsideComments.map(comment => comment.body ?? ''),
    ]
    const matches = texts.filter(text => /\bM\d{1,2}\b|milestone/i.test(text))
    const branding = { queried, results: { issues: issues.length, issueComments: issueComments.length, pulls: pulls.length, reviewComments: reviewComments.length, commits: commits.length, branches: branches.length, outsideComments: outsideComments.length }, scanned: texts.length, matches: matches.length }
    evidence.branding = branding
    console.log(`[LIVE-TEXT] scanned=${branding.scanned} matches=${branding.matches} queried=${queried.length}`)
    expect(matches).toHaveLength(0)
  }, 300_000)
})
