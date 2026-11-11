/**
 * Live forced-stop run against the playground repository: the daemon is started as a child process through the CLI entry with subscription OAuth, SIGKILLed while a ticket's Assignment runs, restarted on the same stateDir, and checked through the store and the GitHub comment list. Gated by SUPERAGENT_CLAUDE_LIVE=1, a configured SUPERAGENT_CLAUDE_LIVE_REPO with its login settings, and the three tokens; never prints a token.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { key, type Ticket, type Trigger } from '../../src/core/index.ts'
import { databasePath, type Receipt } from '../../src/app/store.ts'
import { openReadOnly } from '../../src/app/store-read.ts'
import { sleep } from '../fixtures/async.ts'
import { ghJson } from './gh.ts'
import { assertAllowedRepo } from './guard.ts'
import { liveEnabled, liveTarget, renderLiveText } from './target.ts'

const TARGET = liveTarget()
const LIVE = liveEnabled()
const AGENT_TOKEN = process.env.SUPERAGENT_CLAUDE_GITHUB_TOKEN?.trim()
const OWNER_TOKEN = process.env.SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN?.trim()
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
const REPO = TARGET ? assertAllowedRepo(TARGET.repo) : ''
const AGENT = TARGET?.agentLogin ?? ''
const OWNER = TARGET?.ownerLogin ?? ''
const text = (value: string): string => (TARGET ? renderLiveText(value, TARGET) : value)
const LIMITS = { max: 2, maxTurns: 40, maxBudgetUsd: 2 }
const TIMELINE = ['ticket.created', 'assignment.started', 'assignment.ended', 'ticket.ended']
const MARKER = /<!--\s*superagent-claude:(.+?)\s*-->/
const STRIP = /<!--\s*superagent-claude:.*?-->/g

type Line = Record<string, unknown> & { run?: number }
interface Comment {
  id: number
  body: string
  html_url: string
  created_at: string
  user: { login: string }
}
interface Daemon {
  proc: ChildProcess
  code: number | null
  signal: NodeJS.Signals | null
}

const evidence: Record<string, unknown> = {}
const TOKENS = [AGENT_TOKEN, OWNER_TOKEN, OAUTH].filter((token): token is string => Boolean(token))

async function owner(args: string[]): Promise<unknown> {
  return await ghJson(OWNER_TOKEN!, args)
}

async function createIssue(title: string, body: string): Promise<{ number: number; html_url: string }> {
  return (await owner(['repos/' + REPO + '/issues', '-X', 'POST', '-f', 'title=' + title, '-f', 'body=' + body])) as {
    number: number
    html_url: string
  }
}

async function agentComments(n: number): Promise<Comment[]> {
  const all = (await owner(['repos/' + REPO + '/issues/' + n + '/comments?per_page=100'])) as Comment[]
  return all.filter(comment => comment.user.login === AGENT)
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

describe.skipIf(!LIVE || !AGENT_TOKEN || !OWNER_TOKEN || !OAUTH)('live forced stop', () => {
  let dir = ''
  let configPath = ''
  let config: Record<string, unknown> = {}
  let startedAt = ''
  let issueNumber = 0
  const lines: Line[] = []
  const errs: string[] = []
  const children: Daemon[] = []

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
  const storeQuery = (sql: string, ...params: string[]): Record<string, unknown>[] => {
    const reader = openReadOnly(databasePath(join(dir, 'state')))
    try {
      return reader.db.prepare(sql).all(...params) as Record<string, unknown>[]
    } finally {
      reader.close()
    }
  }
  const triggerOfIssue = (n: number): Trigger | undefined =>
    storeRows<Trigger>('trigger').find(
      trigger => trigger.meta.kind === 'issue' && trigger.meta.number === n && trigger.meta.repository === REPO,
    )
  const ticketById = (id: string): Ticket | undefined => storeRows<Ticket>('ticket').find(ticket => ticket.id === id)
  const threadKeys = (): string[] => storeQuery('SELECT key FROM thread').map(row => String(row.key))
  const receipts = (ticketId: string): Receipt[] =>
    storeRows<Receipt>('outbox').filter(row => row.ticketId === ticketId)

  const daemon = (run: 1 | 2): Daemon => {
    const entry = process.env.SUPERAGENT_CLAUDE_CLI ?? fileURLToPath(new URL('../../src/cli/bin.ts', import.meta.url))
    const proc = spawn(process.execPath, [entry, 'start', '--config', configPath], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env as NodeJS.ProcessEnv,
    })
    const child: Daemon = { proc, code: null, signal: null }
    children.push(child)
    let pending = ''
    proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const text of parts) if (text.trim()) lines.push({ ...(JSON.parse(text) as Line), run })
    })
    proc.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      errs.push(chunk)
    })
    proc.once('exit', (code, signal) => {
      child.code = code
      child.signal = signal
    })
    return child
  }

  const waitStarted = async (run: 1 | 2, child: Daemon): Promise<void> => {
    await until(
      () => {
        if (child.code !== null || child.signal !== null)
          throw new Error(`run ${run} exited before runtime.started: ${errs.join('')}`)
        return lines.find(line => line.run === run && line.event === 'runtime.started')
      },
      90_000,
      1000,
      `runtime.started run ${run}`,
    )
  }

  const stopChild = async (child: Daemon): Promise<void> => {
    if (child.code !== null || child.signal !== null) return
    child.proc.kill('SIGTERM')
    await until(() => (child.code !== null || child.signal !== null ? true : undefined), 60_000, 500, 'daemon exit')
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sac-live-crash-'))
    configPath = join(dir, 'superagent-claude.json')
    config = {
      repositories: [REPO],
      policy: { allowed: [OWNER], acceptMode: 'auto' },
      auth: { mode: 'subscription', owner: OWNER },
      workers: LIMITS,
      stateDir: join(dir, 'state'),
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    startedAt = new Date().toISOString()
    const child = daemon(1)
    await waitStarted(1, child)
    await sleep(20_000)
  }, 120_000)

  afterAll(async () => {
    if (!dir) return
    try {
      for (const child of children) await stopChild(child)
      const last = children.at(-1)
      if (last) expect(last.code).toBe(0)

      const state = join(dir, 'state')
      const files = walk(state)
      const fileHits = files.filter(file => {
        const buffer = readFileSync(file)
        return TOKENS.some(token => buffer.includes(token))
      }).length
      const lineHits = [...lines.map(line => JSON.stringify(line)), ...errs].filter(text =>
        TOKENS.some(token => text.includes(token)),
      ).length
      expect(fileHits).toBe(0)
      expect(lineHits).toBe(0)
      evidence.tokenScan = { files: fileHits, captured: lineHits }

      const serialized = JSON.stringify({ evidence, config, limits: LIMITS, startedAt, warnings: errs })
      const jsonl = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
      expect(TOKENS.some(token => serialized.includes(token) || jsonl.includes(token))).toBe(false)
      const stem = `crash-restart-${stamp(new Date(startedAt))}`
      const outDir = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(
        join(outDir, stem + '.json'),
        JSON.stringify({ config, limits: LIMITS, startedAt, warnings: errs, ...evidence }, null, 2),
      )
      writeFileSync(join(outDir, stem + '.jsonl'), jsonl)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('an issue whose daemon is killed mid-work resumes with the recovery note and gets no duplicate comment', async () => {
    const issue = await createIssue(
      'Question: how is this repository organized?',
      text(
        '@{{agent}} Could you look through the files in this repository and briefly explain how it is organized? No code changes are needed; an answer in this issue is enough.',
      ),
    )
    const n = issue.number
    issueNumber = n

    const running = await until(
      () => {
        const trigger = triggerOfIssue(n)
        if (!trigger) return undefined
        const ticket = storeRows<Ticket>('ticket').find(candidate => candidate.origin.triggerId === trigger.id)
        const assignment = ticket?.assignments.find(candidate => candidate.state === 'running')
        return ticket && assignment
          ? {
              ticketId: ticket.id,
              runningId: assignment.id,
              runningSeenAt: new Date().toISOString(),
              createdAt: ticket.createdAt,
            }
          : undefined
      },
      900_000,
      3000,
      'running assignment',
    )
    const threadKeysAtKill = threadKeys()

    const killed = children[0]!
    killed.proc.kill('SIGKILL')
    await until(() => (killed.signal === 'SIGKILL' ? true : undefined), 30_000, 250, 'SIGKILL exit')
    const killedAt = new Date().toISOString()
    const commentsAtKill = (await agentComments(n)).length

    const child2 = daemon(2)
    await waitStarted(2, child2)
    const restartedAt = new Date().toISOString()

    await until(() => (ticketById(running.ticketId)?.ended ? true : undefined), 1_200_000, 30_000, 'ticket ended')
    await sleep(90_000)

    const ticket = ticketById(running.ticketId)!
    const runningAssignment = ticket.assignments.find(assignment => assignment.id === running.runningId)!
    expect(runningAssignment).toMatchObject({ state: 'ended', endedReason: 'hostRestarted' })
    const later = ticket.assignments.find(assignment => assignment.id !== running.runningId)!
    expect(later).toBeDefined()
    const restartInput = ticket.inputs.find(input => input.id === key('input', running.ticketId, 'restart', later.id))!
    expect(restartInput).toMatchObject({ kind: 'text' })
    expect((restartInput as { text: string }).text).toContain('The host restarted')
    expect(ticket.undelivered).not.toContain(restartInput.id)
    expect(ticket.createdAt).toBe(running.createdAt)
    const threadKeysNow = new Set(threadKeys())
    expect(threadKeysAtKill.every(threadKey => threadKeysNow.has(threadKey))).toBe(true)

    const comments = await agentComments(n)
    expect(comments.length).toBeGreaterThanOrEqual(1)
    expect(new Set(comments.map(comment => markerId(comment.body))).size).toBe(comments.length)
    expect(new Set(comments.map(comment => stripMarker(comment.body))).size).toBe(comments.length)
    const rows = receipts(running.ticketId)
    for (const comment of comments) {
      expect(rows.find(row => row.id === markerId(comment.body))?.status).toBe('sent')
    }
    expect(rows.some(row => row.status === 'pending')).toBe(false)
    expect(lines.some(line => line.run === 2 && line.event === 'store.error')).toBe(false)

    evidence.issue = { url: issue.html_url, number: n }
    evidence.ticketId = running.ticketId
    evidence.runningId = running.runningId
    evidence.runningSeenAt = running.runningSeenAt
    evidence.killedAt = killedAt
    evidence.restartedAt = restartedAt
    evidence.assignments = ticket.assignments.map(assignment => ({
      id: assignment.id,
      state: assignment.state,
      endedReason: assignment.endedReason ?? null,
    }))
    evidence.restartInput = restartInput.id
    evidence.comments = comments.map(comment => ({
      id: markerId(comment.body),
      html_url: comment.html_url,
      marker: comment.body.match(MARKER)?.[0] ?? null,
      created_at: comment.created_at,
    }))
    evidence.commentsAtKill = commentsAtKill
    evidence.duplicates = { markers: 0, bodies: 0 }
    evidence.timeline = lines
      .filter(line => line.ticketId === running.ticketId && TIMELINE.includes(String(line.event)))
      .map(line => ({ run: line.run, at: line.at, event: line.event }))
    console.log(
      `[CRASH] issue=${issue.html_url} ticketId=${running.ticketId} runningId=${running.runningId} killedAt=${killedAt} restartedAt=${restartedAt}`,
    )
  }, 1_800_000)

  it('no live content names a milestone', async () => {
    const issue = (await owner(['repos/' + REPO + '/issues/' + issueNumber])) as { title: string; body?: string | null }
    const agents = await agentComments(issueNumber)
    const texts = [issue.title, issue.body ?? '', ...agents.map(comment => comment.body)]
    expect(texts.filter(text => /\bM\d+\b|milestone/i.test(text))).toHaveLength(0)
  }, 120_000)
})
