/**
 * Live conversation run against the playground repository: the daemon started through the CLI in auto mode with subscription OAuth. A mention that asks for something outside the repository gets one refusal on its issue, also after a daemon restart. A pull request whose ticket is ready keeps that report when a CI event arrives after a handed-back comment. Evidence is read from the store, GitHub and the logs. Gated by SUPERAGENT_CLAUDE_LIVE=1 and the three tokens; never prints a token.
 */
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { latestReport, type Decision, type Ticket, type TicketInput, type Trigger } from '../../src/core/index.ts'
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
const LIMITS = { max: 1, maxTurns: 40, maxBudgetUsd: 1 }
const MARKER = /<!--\s*superagent-claude:(.+?)\s*-->/
const STRIP = /<!--\s*superagent-claude:.*?-->/g
const REFUSAL_PREFIX = "I can't take this on here: "
const DINNER_TITLE = 'Dinner reservation for Friday'
const DINNER_BODY = '@ok0-worker please book a table for two at a restaurant near the office for Friday evening.'
const NOTES_TITLE = 'Add a notes file'
const NOTES_BODY = '@ok0-worker please add a file NOTES.md containing the single line "notes" and open a pull request.'
const PR_COMMENT = '@ok0-worker also, could you book a table for Friday dinner?'

type Line = Record<string, unknown>
interface Comment { id: number; body: string; html_url: string; created_at: string; user: { login: string } }
interface Pull { number: number; html_url: string; title: string; body?: string | null; created_at: string; head: { ref: string; sha: string }; user: { login: string } }
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

describe.skipIf(!LIVE || !AGENT_TOKEN || !OWNER_TOKEN || !OAUTH)('live conversation', () => {
  let dir = ''
  let configPath = ''
  let config: Record<string, unknown> = {}
  let startedAt = ''
  const lines: Line[] = []
  const errs: string[] = []
  let signals = new EventEmitter()
  let exitCode: number | undefined
  let done: Promise<number> = Promise.resolve(-1)
  let running = false
  let failed = false
  let scanned = false
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
  const handbacksOf = (triggerId: string): number => {
    const row = storeQuery('SELECT value FROM disposition WHERE id = ?', triggerId)[0]
    return row ? ((JSON.parse(String(row.value)) as { handbacks?: unknown[] }).handbacks?.length ?? 0) : 0
  }
  const triggerOfComment = (commentId: number): Trigger | undefined =>
    storeRows<Trigger>('trigger').find(trigger => trigger.meta.commentId === commentId && trigger.meta.repository === REPO)
  const triggerOfIssue = (n: number): Trigger | undefined =>
    storeRows<Trigger>('trigger').find(trigger => trigger.meta.kind === 'issue' && trigger.meta.number === n && trigger.meta.repository === REPO)
  const ticketById = (id: string): Ticket | undefined => storeRows<Ticket>('ticket').find(ticket => ticket.id === id)
  const needsText = async (): Promise<string> => {
    const out: string[] = []
    const code = await main(['needs', '--config', configPath], { out: s => { out.push(s) }, err: () => {}, cwd: dir, env: process.env, signals: new EventEmitter() })
    expect(code).toBe(0)
    return out.join('')
  }

  const start = async (): Promise<void> => {
    const before = lines.length
    signals = new EventEmitter()
    exitCode = undefined
    done = main(['start', '--config', configPath], {
      out: s => { for (const line of s.split('\n')) if (line.trim()) lines.push(JSON.parse(line) as Line) },
      err: s => { errs.push(s) },
      cwd: dir,
      env: process.env,
      signals,
    }).then(code => { exitCode = code; running = false; return code })
    running = true
    await until(() => {
      if (exitCode !== undefined) throw new Error(errs.join(''))
      return lines.slice(before).find(line => line.event === 'runtime.started')
    }, 90_000, 1000, 'runtime.started')
    await sleep(20_000)
  }

  const stop = async (): Promise<void> => {
    if (!running) return
    signals.emit('SIGTERM')
    expect(await done).toBe(0)
    running = false
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sac-live-conv-'))
    configPath = join(dir, 'superagent-claude.json')
    config = { repositories: [REPO], policy: { allowed: [OWNER], acceptMode: 'auto' }, auth: { mode: 'subscription', owner: OWNER }, delivery: { allowAutoMerge: false }, workers: LIMITS, stateDir: join(dir, 'state') }
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    startedAt = new Date().toISOString()
    await start()
  }, 180_000)

  afterAll(async () => {
    if (!dir) return
    try {
      await stop()

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
      const stem = `conversation-${stamp(new Date(startedAt))}`
      const outDir = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, stem + '.json'), JSON.stringify({ config, limits: LIMITS, startedAt, warnings: errs, ...evidence }, null, 2))
      writeFileSync(join(outDir, stem + '.jsonl'), jsonl)
    } finally {
      if (failed && scanned) {
        const kept = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw', `conversation-failed-${stamp(new Date(startedAt))}`)
        mkdirSync(kept, { recursive: true })
        for (const name of readdirSync(join(dir, 'state')).filter(name => name.startsWith(DATABASE_FILE))) copyFileSync(join(dir, 'state', name), join(kept, name))
        writeFileSync(join(kept, 'log.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
        console.log(`[LIVE-KEPT] ${kept}`)
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('a mention asking for something outside the repository gets one refusal, also after a restart', async () => {
    const issue = await createIssue(DINNER_TITLE, DINNER_BODY)
    const n = issue.number
    const trigger = await until(() => triggerOfIssue(n), 300_000, 5_000, 'trigger for the issue')
    await until(() => {
      if (storeRows<Ticket>('ticket').some(ticket => ticket.origin.triggerId === trigger.id)) throw new Error(`router accepted the request on ${issue.html_url}: a ticket was created; reword once and re-run`)
      return storeRows<Decision>('decision').some(decision => decision.kind === 'ignore' && decision.triggerIds.includes(trigger.id)) ? true : undefined
    }, 600_000, 15_000, 'ignore decision for the issue')
    await until(async () => (await agentComments(n)).length >= 1 ? true : undefined, 600_000, 15_000, 'refusal comment on the issue')
    await sleep(60_000)
    const beforeRestart = await agentComments(n)
    expect(beforeRestart).toHaveLength(1)
    const comment = beforeRestart[0]!
    const body = stripMarker(comment.body)
    expect(body.startsWith(REFUSAL_PREFIX)).toBe(true)
    expect(body.length).toBeLessThanOrEqual(200)
    expect(body).not.toMatch(/ticket|worker|hand back|trigger|\beval/i)
    expect(markerId(comment.body)).toBe('refusal:' + trigger.id)
    expect(storeRows<Ticket>('ticket').filter(ticket => ticket.origin.triggerId === trigger.id)).toHaveLength(0)

    await stop()
    await start()
    await sleep(120_000)
    const afterRestart = await agentComments(n)
    expect(afterRestart).toHaveLength(1)
    const receipts = storeRows<Receipt>('outbox').filter(row => row.id === 'refusal:' + trigger.id)
    expect(receipts).toHaveLength(1)

    evidence.refusal = {
      issue: issue.html_url,
      trigger: trigger.id,
      comment: { url: comment.html_url, body, id: markerId(comment.body), createdAt: comment.created_at },
      commentsAfterRestart: afterRestart.length,
      receipts: receipts.map(row => ({ id: row.id, kind: row.kind, status: row.status })),
      restarted: true,
    }
    console.log(`[CONVERSATION] refusal issue=${issue.html_url} comment=${comment.html_url} createdAt=${comment.created_at} body=${JSON.stringify(body)}`)
    console.log(`[CONVERSATION] refusal commentsAfterRestart=${afterRestart.length} receipts=${receipts.length} receiptStatus=${String(receipts[0]?.status)}`)
  }, 1_500_000)

  it('a finished pull request keeps its ready report when CI ends after a handed-back comment', async () => {
    const t0 = Date.now()
    const issue = await createIssue(NOTES_TITLE, NOTES_BODY)
    const issueTrigger = await until(() => triggerOfIssue(issue.number), 300_000, 5_000, 'trigger for the issue')
    const ticketId = await until(() => storeRows<Ticket>('ticket').find(ticket => ticket.origin.triggerId === issueTrigger.id)?.id, 300_000, 5_000, 'ticket for the issue')
    const readyOrFailed = (): 'ready' | undefined => {
      const ticket = ticketById(ticketId)
      if (!ticket) return undefined
      const latest = latestReport(ticket)?.state
      if (latest === 'failed' || latest === 'blocked') throw new Error(`ticket ${ticketId} reported ${latest}`)
      return latest === 'ready' ? 'ready' : undefined
    }
    const pull = await until(async () => {
      const ticket = ticketById(ticketId)
      if (!ticket) return undefined
      const latest = latestReport(ticket)?.state
      if (latest === 'failed' || latest === 'blocked') throw new Error(`ticket ${ticketId} reported ${latest} before a PR was opened`)
      const pulls = await agentPulls()
      return pulls.find(item => item.head.ref.startsWith('agent/') && ticket.follows?.some(follow => follow.own && follow.thread.toLowerCase() === ('github:' + REPO + '#' + item.number).toLowerCase()))
    }, 900_000, 20_000, 'PR opened by the agent for the ticket')
    const prNumber = pull.number
    await until(readyOrFailed, 900_000, 20_000, 'ready report on the ticket')

    const comment = await addComment(prNumber, PR_COMMENT)
    const commentTrigger = await until(() => triggerOfComment(comment.id), 300_000, 15_000, 'trigger for the PR comment')
    const answered = await until(async () => {
      if (handbacksOf(commentTrigger.id) > 0) return 'handed back by the ticket'
      const answers = (await agentComments(prNumber)).filter(item => Date.parse(item.created_at) > Date.parse(comment.created_at))
      return answers.length > 0 ? 'agent comment' : undefined
    }, 600_000, 15_000, 'handback or agent comment for the PR comment')

    const head = (await owner(['repos/' + REPO + '/pulls/' + prNumber]) as Pull).head.sha
    await owner(['repos/' + REPO + '/statuses/' + head, '-X', 'POST', '-f', 'state=pending', '-f', 'context=check', '-f', 'description=running'])
    await sleep(30_000)
    await owner(['repos/' + REPO + '/statuses/' + head, '-X', 'POST', '-f', 'state=success', '-f', 'context=check', '-f', 'description=passed'])
    const ci = await until(() => storeRows<Trigger>('trigger').find(trigger => trigger.meta.ci === true && trigger.meta.number === prNumber && trigger.meta.repository === REPO), 300_000, 10_000, 'CI trigger for the PR')
    await sleep(120_000)

    const ticket = ticketById(ticketId)!
    const reportState = latestReport(ticket)?.state
    expect(reportState).toBe('ready')
    const needs = await needsText()
    const blockedLines = needs.split('\n').filter(line => line.includes(ticketId) && line.includes('person:blocked'))
    expect(blockedLines).toEqual([])

    const [worker] = storeQuery('SELECT * FROM worker WHERE ticket_id = ?', ticketId)
    expect(worker).toBeDefined()
    expect(Number(worker!.turns)).toBeGreaterThan(0)
    expect(Number(worker!.cost_usd)).toBeLessThanOrEqual(1.15)

    const refusalComments = (await agentComments(prNumber)).filter(item => (MARKER.exec(item.body)?.[1] ?? '').startsWith('refusal:'))
    expect(refusalComments.length).toBeLessThanOrEqual(1)

    const ciInputs = ticket.inputs.filter((input): input is Extract<TicketInput, { kind: 'trigger' }> => input.kind === 'trigger' && input.triggerId === ci.id)
    const ciInput = ciInputs[0]
    const ciQuiet = ciInput?.quiet === true
    const ciUndelivered = ciInput ? ticket.undelivered.includes(ciInput.id) : null
    const limitEvents = lines.filter(line => line.event === 'worker.limit' && line.ticketId === ticketId)

    evidence.notes = {
      issue: issue.html_url,
      pr: pull.html_url,
      ticketId,
      comment: { url: comment.html_url, trigger: commentTrigger.id, answered },
      ci: { trigger: ci.id, head, quiet: ciQuiet, undelivered: ciUndelivered, summary: ci.text },
      reportState,
      worker: { turns: Number(worker!.turns), costUsd: Number(worker!.cost_usd) },
      limitEvents,
      needsBlockedLines: blockedLines.length,
      refusalComments: refusalComments.map(item => ({ url: item.html_url, id: markerId(item.body) })),
      durationMs: Date.now() - t0,
    }
    console.log(`[CONVERSATION] pr=${pull.html_url} ticket=${ticketId} commentTrigger=${commentTrigger.id} answered=${answered} comment=${comment.html_url}`)
    console.log(`[CONVERSATION] ci=${ci.id} quiet=${String(ciQuiet)} undelivered=${String(ciUndelivered)} reportState=${String(reportState)} needsBlocked=${blockedLines.length}`)
    console.log(`[CONVERSATION] turns=${String(worker!.turns)} costUsd=${String(worker!.cost_usd)} workerLimitEvents=${limitEvents.length} refusalComments=${refusalComments.length} durationMs=${Date.now() - t0}`)
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
