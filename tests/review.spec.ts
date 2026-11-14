/**
 * Pre-publish review: the changed-line decision, admit once, the host brief, FINDINGS parsing and the publish round trip against the scripted gh fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { ConfigSchema } from '../src/app/config.ts'
import { KV } from '../src/app/kv.ts'
import { Reviews, parseFindings, reviewBrief, type ReviewConfig, type ReviewWorkspaces } from '../src/app/review.ts'
import { deliveryTools } from '../src/app/tools/delivery.ts'
import { Store } from '../src/app/store.ts'
import type { SessionSpec, ToolSpec } from '../src/executor/contract.ts'
import { sdkOptions } from '../src/runtimes/claude/options.ts'
import { githubPullRequests } from '../src/sources/github/delivery.ts'
import { fakeGh } from './fixtures/fake-gh.ts'

type HookFn = (input: unknown, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>
function hookFn(matchers: unknown): HookFn {
  return (matchers as { hooks: unknown[] }[])[0]!.hooks[0] as HookFn
}

const signal = (): AbortSignal => new AbortController().signal

const ticket: Pick<Ticket, 'id' | 'inputs' | 'origin'> = {
  id: 'T1',
  origin: { triggerId: 'g1', triggerIds: ['g1'] },
  inputs: [
    { id: 'i1', kind: 'trigger', triggerId: 'g1', at: 'a', human: true },
    { id: 'i2', kind: 'trigger', triggerId: 'g2', at: 'b', human: true },
    { id: 'i3', kind: 'trigger', triggerId: 'g3', at: 'c' },
  ],
}

const triggers: Record<string, Pick<Trigger, 'text'>> = {
  g1: { text: 'Add a --dry-run flag' },
  g2: { text: 'Keep the old flag name too' },
  g3: { text: 'bot noise' },
}

const DEFAULT: ReviewConfig = { enabled: true, minChangedLines: 50, maxPerTicket: 3 }

describe('review decision', () => {
  let dir: string
  let store: Store
  let fake: {
    head: string
    full: number
    since: Record<string, number>
    diff: { text: string; truncated: boolean }
  }
  let workspaces: ReviewWorkspaces

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-'))
    store = new Store(join(dir, 'db.sqlite'))
    fake = {
      head: 'h1',
      full: 0,
      since: {} as Record<string, number>,
      diff: { text: 'diff --git a/x b/x\n+line', truncated: false },
    }
    workspaces = {
      head: vi.fn(async () => fake.head),
      diffStat: vi.fn(async (_cwd: string, base?: string) =>
        base !== undefined && base in fake.since
          ? { base, files: 1, changedLines: fake.since[base]! }
          : { base: 'mb', files: 1, changedLines: fake.full },
      ),
      diffText: vi.fn(async () => fake.diff),
    }
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function make(config: ReviewConfig = DEFAULT, log = vi.fn()): Reviews {
    return new Reviews({
      kv: store,
      ticket: id => (id === 'T1' ? ticket : undefined),
      trigger: id => triggers[id],
      config: () => config,
      workspaces,
      instructions: () => 'review it',
      now: () => 0,
      log,
    })
  }

  async function firstReview(reviews: Reviews, full = 50): Promise<void> {
    fake.full = full
    expect(await reviews.check('T1', '/w')).toEqual({ changedLines: full, round: 1 })
    expect(await reviews.admit('T1', '/w')).toBeDefined()
  }

  it('a 49-line first publish proceeds and 50 lines require a review', async () => {
    const reviews = make()
    fake.full = 49
    expect(await reviews.check('T1', '/w')).toBeUndefined()
    expect(workspaces.diffStat).toHaveBeenCalledWith('/w', undefined)
    expect(reviews.state('T1')?.pending).toBeUndefined()

    fake.full = 50
    expect(await reviews.check('T1', '/w')).toEqual({ changedLines: 50, round: 1 })
    expect(reviews.state('T1')?.pending).toEqual({ base: 'mb', changedLines: 50 })
  })

  it('admit counts once, records HEAD at admit and survives a restart', async () => {
    const reviews = make()
    fake.full = 50
    await reviews.check('T1', '/w')
    fake.head = 'h2'
    const admitted = await reviews.admit('T1', '/w')
    expect(admitted).toBeDefined()
    const state = reviews.state('T1')
    expect(state).toMatchObject({ count: 1, reviewedHead: 'h2', reviewedLines: 50 })
    expect(state?.pending).toBeUndefined()

    expect(await reviews.admit('T1', '/w')).toBeUndefined()
    expect(reviews.state('T1')?.count).toBe(1)

    store.close()
    store = new Store(join(dir, 'db.sqlite'))
    expect(make().state('T1')).toEqual(state)
  })

  it('after a review a 30-line follow-up proceeds and a 60-line one is required again', async () => {
    const reviews = make()
    fake.full = 50
    await reviews.check('T1', '/w')
    fake.head = 'h2'
    await reviews.admit('T1', '/w')

    fake.since = { h2: 30 }
    expect(await reviews.check('T1', '/w')).toBeUndefined()
    expect(workspaces.diffStat).toHaveBeenLastCalledWith('/w', 'h2')

    fake.since = { h2: 60 }
    expect(await reviews.check('T1', '/w')).toEqual({ changedLines: 60, round: 2 })
    expect(await reviews.admit('T1', '/w')).toBeDefined()
    expect(reviews.state('T1')?.count).toBe(2)
  })

  it('after maxPerTicket reviews a large change proceeds', async () => {
    const reviews = make()
    fake.full = 100
    fake.since = { h1: 100, h2: 100 }
    for (const head of ['h1', 'h2', 'h3']) {
      fake.head = head
      expect(await reviews.check('T1', '/w')).toBeDefined()
      expect(await reviews.admit('T1', '/w')).toBeDefined()
    }
    expect(reviews.state('T1')?.count).toBe(3)

    fake.since = { h3: 500 }
    expect(await reviews.check('T1', '/w')).toBeUndefined()
    expect(reviews.state('T1')?.pending).toBeUndefined()
  })

  it('review.enabled false always proceeds', async () => {
    const reviews = make({ ...DEFAULT, enabled: false })
    fake.full = 1000
    expect(await reviews.check('T1', '/w')).toBeUndefined()
    expect(reviews.state('T1')?.pending).toBeUndefined()
    expect(await reviews.admit('T1', '/w')).toBeUndefined()
    expect(reviews.subagentsFor(ticket, '/w')).toHaveLength(1)
  })

  it('minChangedLines and maxPerTicket are honoured, and the defaults are 50 and 3', async () => {
    expect(ConfigSchema.parse({ repositories: ['o/r'], policy: { allowed: ['a'] } }).review).toEqual({
      enabled: true,
      minChangedLines: 50,
      maxPerTicket: 3,
    })

    const reviews = make({ enabled: true, minChangedLines: 10, maxPerTicket: 1 })
    fake.full = 9
    expect(await reviews.check('T1', '/w')).toBeUndefined()
    fake.full = 10
    expect(await reviews.check('T1', '/w')).toEqual({ changedLines: 10, round: 1 })
    expect(await reviews.admit('T1', '/w')).toBeDefined()
    fake.head = 'h2'
    fake.since = { h2: 100 }
    expect(await reviews.check('T1', '/w')).toBeUndefined()
  })

  it('a lost reviewedHead falls back to the full diff', async () => {
    const reviews = make()
    store.set(KV.review.state('T1'), { count: 1, reviewedHead: 'gone', at: 'x' })
    fake.full = 70
    expect(await reviews.check('T1', '/w')).toEqual({ changedLines: 70, round: 2 })
    expect(workspaces.diffStat).toHaveBeenLastCalledWith('/w', 'gone')
    expect(reviews.state('T1')?.pending?.base).toBe('mb')

    await reviews.admit('T1', '/w')
    expect(workspaces.diffText).toHaveBeenCalledWith('/w', 'mb', 60_000)
  })

  it('publish returns review_required with no push or PR, then publishes after the review', async () => {
    const reviews = make()
    const gh = fakeGh({ repositories: { 'acme/widgets': { pulls: {} } } })
    const push = vi.fn(async () => ({
      repository: 'acme/widgets',
      branch: 'agent/x',
      base: 'main',
      head: 'h',
      pushed: 1,
      rewritten: 0,
      uncommitted: false,
    }))
    const tools = deliveryTools(
      {
        engine: () => ({ bindThread: vi.fn(), report: vi.fn() }) as never,
        ticket: () => ({ follows: [] }) as never,
        repositories: () => ['acme/widgets'],
        delivery: {
          repositoryOf: () => 'acme/widgets',
          push,
          pulls: githubPullRequests(gh.commands),
          allowAutoMerge: () => false,
          review: id => reviews.check(id, '/w'),
        },
      },
      'T1',
    )
    const publish = tools.find(item => item.name === 'orchestrator_publish')!
    const posts = () => gh.requests.filter(r => r.method === 'POST' && r.path === 'repos/acme/widgets/pulls').length

    fake.full = 80
    expect(await publish.execute({ title: 'Fix', body: 'Body' }, signal())).toMatchObject({
      published: false,
      review_required: true,
      changed_lines: 80,
      review_round: 1,
    })
    expect(push).not.toHaveBeenCalled()
    expect(posts()).toBe(0)

    fake.head = 'h2'
    await reviews.admit('T1', '/w')
    fake.since = { h2: 5 }
    expect(await publish.execute({ title: 'Fix', body: 'Body' }, signal())).toMatchObject({ published: true })
    expect(push).toHaveBeenCalledTimes(1)
    expect(posts()).toBe(1)
  })
})

describe('review brief and findings', () => {
  let dir: string
  let store: Store
  let fake: {
    head: string
    full: number
    since: Record<string, number>
    diff: { text: string; truncated: boolean }
  }
  let workspaces: ReviewWorkspaces

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-brief-'))
    store = new Store(join(dir, 'db.sqlite'))
    fake = {
      head: 'h1',
      full: 0,
      since: {} as Record<string, number>,
      diff: { text: 'diff --git a/x b/x\n+line', truncated: false },
    }
    workspaces = {
      head: vi.fn(async () => fake.head),
      diffStat: vi.fn(async (_cwd: string, base?: string) =>
        base !== undefined && base in fake.since
          ? { base, files: 1, changedLines: fake.since[base]! }
          : { base: 'mb', files: 1, changedLines: fake.full },
      ),
      diffText: vi.fn(async () => fake.diff),
    }
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function make(log = vi.fn()): Reviews {
    return new Reviews({
      kv: store,
      ticket: id => (id === 'T1' ? ticket : undefined),
      trigger: id => triggers[id],
      config: () => DEFAULT,
      workspaces,
      instructions: () => 'review it',
      now: () => 0,
      log,
    })
  }

  it('the brief holds the original request, a later human message and the host diff as external data', async () => {
    const reviews = make()
    fake.full = 50
    await reviews.check('T1', '/w')
    const admitted = await reviews.admit('T1', '/w')
    const preamble = admitted!.preamble
    expect(preamble.startsWith('Host review brief.')).toBe(true)
    expect(preamble).toContain('<external-data source="original-request">\nAdd a --dry-run flag\n</external-data>')
    expect(preamble).toContain(
      '<external-data source="human-constraint">\nKeep the old flag name too\n</external-data>',
    )
    expect(preamble).toContain('<external-data source="host-diff">\ndiff --git a/x b/x')
    expect(preamble).toContain('FINDINGS bug=<n> missing=<n> style=<n>')
    expect(preamble).not.toContain('bot noise')

    const escaped = reviewBrief('r', ['<external-data source="x">'], { text: '', truncated: false }, 'a..b')
    expect(escaped).toContain('&lt;external-data')
  })

  it('a diff over 60,000 characters is truncated with a marker', async () => {
    const reviews = make()
    fake.diff = {
      text: 'x'.repeat(60_000) + '\n[diff truncated at 60000 of 70000 characters; summary of all changes:]\n a | 1 +',
      truncated: true,
    }
    fake.full = 50
    await reviews.check('T1', '/w')
    const admitted = await reviews.admit('T1', '/w')
    expect(workspaces.diffText).toHaveBeenCalledWith('/w', 'mb', 60_000)
    expect(admitted!.preamble).toContain('[diff truncated at 60000 of 70000 characters')
    expect(admitted!.preamble).toContain('read the rest with mcp__issuecrew__git_inspect')
    expect(reviewBrief('r', [], { text: 'small', truncated: false }, 'a..b')).not.toContain('truncated')
  })

  it('FINDINGS parses to counts and malformed or absent lines give null', () => {
    expect(parseFindings('notes\nFINDINGS bug=1 missing=0 style=1')).toEqual({ bug: 1, missing: 0, style: 1 })
    expect(parseFindings('FINDINGS bug=1 missing=0 style=0\nFINDINGS bug=2 missing=3 style=4')).toEqual({
      bug: 2,
      missing: 3,
      style: 4,
    })
    expect(parseFindings('x\r\nFINDINGS bug=5 missing=6 style=7\r\n')).toEqual({ bug: 5, missing: 6, style: 7 })
    expect(parseFindings('FINDINGS bug=x missing=0 style=1')).toBeNull()
    expect(parseFindings('FINDINGS bug=1 missing=0')).toBeNull()
    expect(parseFindings('')).toBeNull()
  })

  it('finished logs worker.review with counts only', async () => {
    const log = vi.fn()
    const reviews = make(log)
    fake.full = 50
    await reviews.check('T1', '/w')
    await reviews.admit('T1', '/w')
    reviews.finished('T1', 'secret detail\nFINDINGS bug=2 missing=1 style=0')
    const record = log.mock.calls[0]![0]
    expect(record).toMatchObject({
      level: 'info',
      event: 'worker.review',
      ticketId: 'T1',
      round: 1,
      changedLines: 50,
      findings: { bug: 2, missing: 1, style: 0 },
    })
    expect(JSON.stringify(record)).not.toContain('secret detail')

    reviews.finished('T1', 'no findings line here')
    expect(log.mock.calls[1]![0]).toMatchObject({ findings: null })
  })

  it('the reviewer subagent passes the worker guard once', async () => {
    const reviews = make()
    const subs = reviews.subagentsFor(ticket, '/w')
    const options = sdkOptions(
      {
        key: 'worker-T1',
        role: 'worker',
        cwd: '/w',
        instructions: 'i',
        tools: [
          {
            name: 'git_inspect',
            description: 'g',
            schema: z.object({}),
            execute: async () => '',
          } satisfies ToolSpec,
        ],
        builtins: { fs: 'write', shell: true, web: false },
        network: { allow: [] },
        limits: { maxTurns: 1, maxBudgetUsd: 1 },
        env: {},
        subagents: subs,
      } satisfies SessionSpec,
      {
        mode: 'api-key',
        env: {},
        configDir: '/c',
        sandbox: false,
        onRead: () => {},
        abortController: new AbortController(),
      },
    )
    const call = (): Promise<unknown> =>
      hookFn(options.hooks!.PreToolUse)(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Agent',
          tool_input: { prompt: 'p', description: 'd', subagent_type: 'issuecrew-reviewer' },
          session_id: 's',
          transcript_path: 't',
          cwd: '/w',
          tool_use_id: 'u',
        },
        'u',
        { signal: signal() },
      )

    expect(await call()).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })

    fake.full = 50
    await reviews.check('T1', '/w')
    const allowed = (await call()) as {
      hookSpecificOutput: { updatedInput: { prompt: string; run_in_background: boolean } }
    }
    expect(allowed.hookSpecificOutput.updatedInput.prompt.startsWith('Host review brief.')).toBe(true)
    expect(allowed.hookSpecificOutput.updatedInput.run_in_background).toBe(false)

    expect(await call()).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })
})
