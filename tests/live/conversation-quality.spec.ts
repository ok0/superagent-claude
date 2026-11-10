/**
 * Live conversation quality run against the playground repository: the daemon started through the CLI in auto mode with subscription OAuth. Checks that a steer which changes the request renames the ticket in status and needs and that its pull request carries only the requested files; that an acknowledgement does not assert a premise the request does not give; that an out-of-scope refusal has a readable reason, with the raw reason and the posted body recorded; and that no live content in the repository names a milestone. Evidence is read from the store, GitHub and the logs. Gated by SUPERAGENT_CLAUDE_LIVE=1 and the three tokens; never prints a token.
 */
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { latestReport, type Decision, type Ticket, type Trigger } from '../../src/core/index.ts'
import { main } from '../../src/cli/main.ts'
import { DATABASE_FILE, databasePath } from '../../src/app/store.ts'
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
const FALLBACK_BODY = REFUSAL_PREFIX + 'it is outside what I can do.'
const INTERNAL_TERMS = /\b(?:tickets?|workers?|hand(?:ed|s|ing)?[\s-]?backs?|evals?|triggers?|orchestrator|assignments?)\b|\b[0-9a-f]{16,}\b/i
const AGREED_NAME = /\b(?:to|as) the agreed (?:new )?name\b/i
const STEER_TITLE = 'Add a greeting file'
const STEER_BODY = '@ok0-worker please add a file GREETING.md containing the single line "hello" and open a pull request.'
const STEER_COMMENT = '@ok0-worker change of plan: name the file WELCOME.md instead, with the single line "welcome", and do not add GREETING.md.'
const RENAME_TITLE = 'Rename the helper'
const RENAME_BODY = '@ok0-worker please rename the helper to the name we agreed on.'
const WEEKEND_TITLE = 'Weekend plans'
const WEEKEND_BODY = '@ok0-worker could you suggest a good hiking trail for this weekend?'

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

describe.skipIf(!LIVE || !AGENT_TOKEN || !OWNER_TOKEN || !OAUTH)('live conversation quality', () => {
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
  const triggerOfIssue = (n: number): Trigger | undefined =>
    storeRows<Trigger>('trigger').find(trigger => trigger.meta.kind === 'issue' && trigger.meta.number === n && trigger.meta.repository === REPO)
  const ticketById = (id: string): Ticket | undefined => storeRows<Ticket>('ticket').find(ticket => ticket.id === id)
  const needsText = async (all = false): Promise<string> => {
    const out: string[] = []
    const code = await main(['needs', ...(all ? ['--all'] : []), '--config', configPath], { out: s => { out.push(s) }, err: () => {}, cwd: dir, env: process.env, signals: new EventEmitter() })
    expect(code).toBe(0)
    return out.join('')
  }
  const statusText = async (): Promise<string> => {
    const out: string[] = []
    const code = await main(['status', '--config', configPath], { out: s => { out.push(s) }, err: () => {}, cwd: dir, env: process.env, signals: new EventEmitter() })
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
    dir = mkdtempSync(join(tmpdir(), 'sac-live-quality-'))
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
      const stem = `conversation-quality-${stamp(new Date(startedAt))}`
      const outDir = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, stem + '.json'), JSON.stringify({ config, limits: LIMITS, startedAt, warnings: errs, ...evidence }, null, 2))
      writeFileSync(join(outDir, stem + '.jsonl'), jsonl)
    } finally {
      if (failed && scanned) {
        const kept = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw', `conversation-quality-failed-${stamp(new Date(startedAt))}`)
        mkdirSync(kept, { recursive: true })
        for (const name of readdirSync(join(dir, 'state')).filter(name => name.startsWith(DATABASE_FILE))) copyFileSync(join(dir, 'state', name), join(kept, name))
        writeFileSync(join(kept, 'log.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
        console.log(`[LIVE-KEPT] ${kept}`)
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('a steer that changes the request renames the ticket and the pull request carries only the requested files', async () => {
    const t0 = Date.now()
    const issue = await createIssue(STEER_TITLE, STEER_BODY)
    const n = issue.number
    const trigger = await until(() => triggerOfIssue(n), 300_000, 5_000, 'trigger for the issue')
    const ticketId = await until(() => storeRows<Ticket>('ticket').find(ticket => ticket.origin.triggerId === trigger.id)?.id, 600_000, 10_000, 'ticket for the issue')
    await until(async () => (await agentComments(n)).length >= 1 ? true : undefined, 600_000, 15_000, 'first agent comment on the issue')
    const initialTitle = ticketById(ticketId)!.title

    const steer = await addComment(n, STEER_COMMENT)
    const pull = await until(async () => {
      const ticket = ticketById(ticketId)
      if (!ticket) return undefined
      const pulls = await agentPulls()
      return pulls.find(item => item.head.ref.startsWith('agent/') && ticket.follows?.some(follow => follow.own && follow.thread.toLowerCase() === ('github:' + REPO + '#' + item.number).toLowerCase()))
    }, 1_200_000, 20_000, 'pull request for the ticket')
    const ready = await until(() => {
      const report = latestReport(ticketById(ticketId)!)
      if (report?.state === 'failed' || report?.state === 'blocked') throw new Error(`ticket ${ticketId} reported ${report.state}`)
      return report?.state === 'ready' && Date.parse(report.at) >= Date.parse(steer.created_at) ? report : undefined
    }, 1_200_000, 20_000, 'ready report after the steer')

    const renamed = await until(() => { const title = ticketById(ticketId)?.title; return title !== undefined && title !== initialTitle ? title : undefined }, 600_000, 20_000, 'renamed ticket title')
    const ticket = ticketById(ticketId)!
    const titleAfter = renamed
    const status = await statusText()
    const needs = await needsText(true)
    const files = (await owner(['repos/' + REPO + '/pulls/' + pull.number + '/files?per_page=100']) as { filename: string }[]).map(file => file.filename)
    const workers = storeQuery('SELECT * FROM worker WHERE ticket_id = ?', ticketId)
    const turns = workers.reduce((sum, row) => sum + Number(row.turns), 0)
    const costUsd = workers.reduce((sum, row) => sum + Number(row.cost_usd), 0)

    evidence.steer = {
      issue: issue.html_url,
      ticketId,
      initialTitle,
      titleAfter,
      steer: steer.html_url,
      readyAt: ready.at,
      renamedAt: ticket.updatedAt,
      pr: pull.html_url,
      files,
      statusHasTitle: status.includes(titleAfter),
      needsHasTitle: needs.includes(titleAfter),
      worker: { turns, costUsd },
      durationMs: Date.now() - t0,
    }
    console.log(`[QUALITY] steer initialTitle=${JSON.stringify(initialTitle)} titleAfter=${JSON.stringify(titleAfter)} pr=${pull.html_url} files=${JSON.stringify(files)} costUsd=${String(costUsd)} turns=${String(turns)}`)

    expect(titleAfter).not.toBe(initialTitle)
    expect(titleAfter).toMatch(/welcome/i)
    expect(status.includes(titleAfter) || needs.includes(titleAfter)).toBe(true)
    expect(files.length).toBeGreaterThan(0)
    expect(files).not.toContain('.gitignore')
    expect(files.every(file => ['WELCOME.md'].includes(file))).toBe(true)
  }, 4_800_000)

  it('an acknowledgement does not assert a premise the request does not give', async () => {
    const t0 = Date.now()
    const issue = await createIssue(RENAME_TITLE, RENAME_BODY)
    const n = issue.number
    const trigger = await until(() => triggerOfIssue(n), 300_000, 5_000, 'trigger for the issue')
    await until(async () => {
      if ((await agentComments(n)).length > 0) return true
      if (storeRows<Decision>('decision').some(decision => decision.kind === 'ignore' && decision.triggerIds.includes(trigger.id))) return true
      return storeRows<Ticket>('ticket').some(ticket => ticket.origin.triggerId === trigger.id && ticket.attention !== undefined) ? true : undefined
    }, 600_000, 15_000, 'first agent comment, ignore decision or attention question')

    const comments = await agentComments(n)
    const firstBody = comments[0] ? stripMarker(comments[0].body) : undefined
    const decision = storeRows<Decision>('decision').find(item => item.triggerIds.includes(trigger.id))
    const ticket = storeRows<Ticket>('ticket').find(item => item.origin.triggerId === trigger.id)
    const attention = ticket?.attention?.question

    if (firstBody !== undefined) expect(firstBody.includes('?') || !AGREED_NAME.test(firstBody)).toBe(true)

    evidence.premise = {
      issue: issue.html_url,
      trigger: trigger.id,
      firstComment: comments[0] ? { url: comments[0].html_url, body: firstBody, id: markerId(comments[0].body) } : null,
      decisionKind: decision?.kind ?? null,
      attention: attention ?? null,
      durationMs: Date.now() - t0,
    }
    console.log(`[QUALITY] premise firstComment=${JSON.stringify(firstBody ?? null)} decision=${String(decision?.kind)} attention=${JSON.stringify(attention ?? null)}`)
  }, 900_000)

  it('an out-of-scope mention gets a refusal whose reason is readable', async () => {
    const issue = await createIssue(WEEKEND_TITLE, WEEKEND_BODY)
    const n = issue.number
    const trigger = await until(() => triggerOfIssue(n), 300_000, 5_000, 'trigger for the issue')
    const decision = await until(() => {
      if (storeRows<Ticket>('ticket').some(ticket => ticket.origin.triggerId === trigger.id)) throw new Error(`router accepted the request on ${issue.html_url}: a ticket was created; reword once and re-run`)
      return storeRows<Decision>('decision').find(item => item.kind === 'ignore' && item.triggerIds.includes(trigger.id))
    }, 600_000, 15_000, 'ignore decision for the issue')
    const comment = await until(async () => (await agentComments(n))[0], 600_000, 15_000, 'refusal comment on the issue')
    const body = stripMarker(comment.body)
    const fallback = body === FALLBACK_BODY

    expect(body.startsWith(REFUSAL_PREFIX)).toBe(true)
    expect(body.length).toBeLessThanOrEqual(200)
    expect(body).not.toMatch(INTERNAL_TERMS)

    evidence.refusal = {
      issue: issue.html_url,
      trigger: trigger.id,
      reason: decision.reason,
      comment: { url: comment.html_url, body, id: markerId(comment.body), createdAt: comment.created_at },
      fallback,
    }
    console.log(`[QUALITY] refusal reason=${JSON.stringify(decision.reason)} body=${JSON.stringify(body)} fallback=${String(fallback)}`)
  }, 1_800_000)

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
