/**
 * The GitHub polling Source over the fake gh: start probes, per-repository cursors and health, the six
 * event kinds, failure isolation, interval and abort.
 */
import { afterEach, expect, it } from 'vitest'
import type { Thread, Ticket } from '../src/core/index.ts'
import { githubSource, pollRepository, type GithubSourceOptions } from '../src/sources/github/source.ts'
import { threadId, threadKeyOf } from '../src/sources/github/trigger.ts'
import { sleep, waitUntil } from './fixtures/async.ts'
import { ManualClock } from './fixtures/executor.ts'
import {
  AGENT,
  AT,
  comment,
  fakeGh,
  issue,
  notification,
  pull,
  recordingHost,
  START,
  type FakeGh,
  type FakeGhScript,
  type Recording,
} from './fixtures/fake-gh.ts'

const A = 'acme/widgets'
const B = 'acme/gadgets'
const START_ISO = new Date(START).toISOString()

interface Harness {
  gh: FakeGh
  clock: ManualClock
  source: ReturnType<typeof githubSource>
  rec: Recording
  start(): Promise<void>
  round(): Promise<void>
  next(): Promise<void>
}

const harnesses: Harness[] = []
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.source.service.stop()
})

function harness(script: FakeGhScript, options: Partial<GithubSourceOptions> = {}): Harness {
  const gh = fakeGh(script)
  const clock = new ManualClock(START)
  const source = githubSource({
    repositories: Object.keys(script.repositories),
    commands: gh.commands,
    timers: clock,
    now: clock.now,
    ...options,
  })
  const rec = recordingHost(source.kind)
  const built: Harness = {
    gh,
    clock,
    source,
    rec,
    start: () => source.service.start(rec.host, new AbortController().signal),
    round: async () => {
      await waitUntil(() => clock.pending === 1)
    },
    next: async () => {
      clock.advance(60_000)
      await waitUntil(() => clock.pending === 1)
    },
  }
  harnesses.push(built)
  return built
}

const thread = (
  repository: string,
  number: number,
  meta: Record<string, unknown>,
  subscriptions: string[] = ['T1'],
): Thread => ({
  key: threadKeyOf(repository, number),
  ref: { source: 'github', id: threadId(repository, number) },
  createdAt: START_ISO,
  subscriptions,
  correlated: [],
  pending: [],
  meta,
})
const ticket = (id: string): Ticket => ({ id, ended: undefined, follows: [] }) as unknown as Ticket

it('records access and push per repository at start and never polls an inaccessible one', async () => {
  const h = harness({
    repositories: {
      'acme/widgets': { access: { push: true }, notifications: [] },
      'acme/tools': { access: { push: false }, notifications: [] },
      'acme/gadgets': { access: { status: 404 } },
    },
  })
  await h.start()
  expect(h.rec.state.get('repo-access:acme/widgets')).toMatchObject({ accessible: true, push: true })
  expect(h.rec.state.get('repo-access:acme/tools')).toMatchObject({ accessible: true, push: false })
  expect(h.rec.state.get('repo-access:acme/gadgets')).toMatchObject({ accessible: false })
  expect(h.rec.board.all['github:acme/gadgets']?.state).toBe('error')
  expect(h.rec.board.all['github:acme/widgets']?.values).toMatchObject({ push: 'true' })
  await h.round()
  expect(h.gh.calls.some(call => call.startsWith('repos/acme/widgets/notifications'))).toBe(true)
  expect(h.gh.calls.some(call => call.startsWith('repos/acme/tools/notifications'))).toBe(true)
  expect(h.gh.calls.some(call => call.startsWith('repos/acme/gadgets/'))).toBe(false)
})

it('starts without refusing when no repository is accessible', async () => {
  const h = harness({
    repositories: { 'acme/widgets': { access: { status: 403 } }, 'acme/tools': { access: { status: 403 } } },
  })
  await h.start()
  expect(h.rec.board.all.github?.state).toBe('error')
  expect(h.gh.calls.some(call => call.includes('notifications'))).toBe(false)
  expect(h.clock.pending).toBe(0)
})

it('does not poll when the agent account cannot be read', async () => {
  const h = harness({ userStatus: 401, repositories: { 'acme/widgets': { notifications: [] } } })
  await h.start()
  expect(h.gh.calls).toEqual(['user'])
  expect(h.rec.board.all.github?.state).toBe('error')
})

it('normalizes the six event kinds from notifications, the pull request and its checks', async () => {
  const h = harness({
    repositories: {
      'acme/widgets': {
        notifications: [notification(A, 1), notification(A, 2, true)],
        issues: {
          1: issue(A, 1, { body: '@agent-bot please look' }),
          2: pull(A, 2, { user: { login: 'bob', type: 'User' } }),
        },
        pulls: { 2: pull(A, 2, { user: { login: 'bob', type: 'User' } }) },
        comments: { 1: [comment(A, 1, 11)], 2: [comment(A, 2, 21)] },
        reviewComments: {
          2: [
            {
              ...comment(A, 2, 22),
              path: 'src/a.ts',
              line: 3,
              html_url: 'https://github.com/acme/widgets/pull/2#discussion_r22',
            },
          ],
        },
        reviews: {
          2: [
            {
              id: 23,
              body: '',
              state: 'APPROVED',
              commit_id: 'abc',
              user: { login: 'dave', type: 'User' },
              submitted_at: AT,
              html_url: 'https://github.com/acme/widgets/pull/2#pullrequestreview-23',
            },
          ],
        },
        checkRuns: { abc: [{ name: 'ci', status: 'completed', conclusion: 'success' }] },
      },
    },
  })
  h.rec.threads.push(thread(A, 2, { isPr: true, title: 'p', number: 2, repository: A }))
  h.rec.tickets.set('T1', ticket('T1'))
  await h.start()
  await h.round()
  const kinds = new Set(h.rec.received.map(item => item.trigger.meta.kind))
  expect([...kinds]).toEqual(expect.arrayContaining(['issue', 'conversation', 'pull', 'inline', 'review']))
  for (const { trigger } of h.rec.received) {
    expect(trigger.source).toBe('github')
    expect(trigger.meta.repository).toBe(A)
    expect(['acme/widgets#1', 'acme/widgets#2']).toContain(trigger.threads[0]!.id)
  }
  const issueTrigger = h.rec.received.find(item => item.trigger.meta.kind === 'issue')!.trigger
  expect(issueTrigger.addressed).toBe('mention')
  expect(issueTrigger.actor.id).toBe('alice')
  h.gh.script.repositories['acme/widgets']!.checkRuns = {
    abc: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
  }
  const before = h.rec.received.length
  await h.next()
  const ci = h.rec.received.slice(before).filter(item => item.trigger.meta.ci === true)
  expect(ci.length).toBe(1)
  expect(ci[0]!.trigger).toMatchObject({ actor: { id: '' }, human: false, threads: [{ id: 'acme/widgets#2' }] })
})

it('re-polling gives duplicates and keeps cursors per repository', async () => {
  const h = harness({
    repositories: {
      'acme/widgets': { notifications: [notification(A, 1)], issues: { 1: issue(A, 1) } },
      'acme/gadgets': { notifications: [notification(B, 1)], issues: { 1: issue(B, 1) } },
    },
  })
  await h.start()
  await h.round()
  expect(h.rec.received.every(item => item.result === 'stored')).toBe(true)
  const widgets = h.rec.received.find(item => item.trigger.threads[0]!.id === 'acme/widgets#1')!.trigger.id
  const gadgets = h.rec.received.find(item => item.trigger.threads[0]!.id === 'acme/gadgets#1')!.trigger.id
  expect(widgets).not.toBe(gadgets)
  const before = h.rec.received.length
  await h.next()
  const again = h.rec.received.slice(before)
  expect(again.length).toBeGreaterThan(0)
  expect(again.every(item => item.result === 'duplicate')).toBe(true)
  expect([...h.rec.state.keys()]).toEqual(
    expect.arrayContaining(['github-since:acme/widgets', 'github-since:acme/gadgets']),
  )
})

it('a failing Thread blocks neither other Threads nor the next repository', async () => {
  const h = harness({
    repositories: {
      'acme/widgets': {
        failures: { 'issues/3/comments': 500 },
        comments: { 3: [comment(A, 3, 31)], 4: [comment(A, 4, 41)] },
      },
      'acme/gadgets': { comments: { 3: [comment(B, 3, 51)] } },
    },
  })
  const meta = (repository: string, number: number) => ({ isPr: false, title: 't', number, repository })
  h.rec.threads.push(thread(A, 3, meta(A, 3)), thread(A, 4, meta(A, 4)), thread(B, 3, meta(B, 3)))
  h.rec.tickets.set('T1', ticket('T1'))
  await h.start()
  await h.round()
  expect(h.rec.patches).toContainEqual(
    expect.objectContaining({
      key: 'github:acme/widgets#3',
      meta: expect.objectContaining({ pollError: expect.stringContaining('500') }),
    }),
  )
  const threads = h.rec.received.map(item => item.trigger.threads[0]!.id)
  expect(threads).toEqual(expect.arrayContaining(['acme/widgets#4', 'acme/gadgets#3']))
  expect(h.rec.board.all['github:acme/widgets']?.values).toMatchObject({ count: '1' })
  expect(h.rec.board.all['github:acme/gadgets']?.state).toBe('ready')
})

it('reports consecutive failures and keeps polling the other repository', async () => {
  const h = harness({
    repositories: {
      'acme/widgets': { failures: { notifications: 500 } },
      'acme/gadgets': { notifications: [] },
    },
  })
  await h.start()
  await h.round()
  expect(h.rec.board.all['github:acme/widgets']).toMatchObject({ state: 'ready', values: { count: '1' } })
  await h.next()
  expect(h.rec.board.all['github:acme/widgets']).toMatchObject({ state: 'ready', values: { count: '2' } })
  await h.next()
  expect(h.rec.board.all['github:acme/widgets']).toMatchObject({ state: 'error', values: { count: '3' } })
  expect(h.rec.board.all['github:acme/widgets']?.values?.error).toContain('500')
  expect(h.gh.calls.filter(call => call.startsWith('repos/acme/gadgets/notifications')).length).toBe(3)
})

it('polls the repositories in order every 60 s, never sooner', async () => {
  const h = harness(
    { repositories: { 'acme/widgets': { notifications: [] }, 'acme/gadgets': { notifications: [] } } },
    { intervalMs: 30_000 },
  )
  await h.start()
  await h.round()
  const order = h.gh.calls
  expect(order.findIndex(call => call.startsWith('repos/acme/widgets/notifications'))).toBeLessThan(
    order.findIndex(call => call.startsWith('repos/acme/gadgets/notifications')),
  )
  const n = h.gh.calls.length
  h.clock.advance(30_000)
  await sleep(20)
  expect(h.gh.calls.length).toBe(n)
  h.clock.advance(29_999)
  await sleep(20)
  expect(h.gh.calls.length).toBe(n)
  h.clock.advance(1)
  await waitUntil(() => h.gh.calls.length > n)
})

it('reports the rate limit in health', async () => {
  const h = harness({ repositories: { 'acme/widgets': { notifications: [] } } })
  await h.start()
  await h.round()
  expect(h.rec.board.all['github:acme/widgets']).toMatchObject({ state: 'ready', values: { rateRemaining: '4999' } })
  expect(h.rec.board.all['github:acme/widgets']?.detail).toContain('rate limit 4999 remaining')
})

it('sends nothing after stop', async () => {
  const h = harness({ repositories: { 'acme/widgets': { notifications: [] } } })
  const hold = h.gh.hold('repos/acme/widgets/notifications')
  await h.start()
  await waitUntil(() => hold.reached())
  const stopping = h.source.service.stop()
  hold.release()
  await stopping
  const n = h.gh.calls.length
  h.clock.advance(120_000)
  await sleep(20)
  expect(h.gh.calls.length).toBe(n)
})

it('ingests the body of an Issue first read after its creation even when the repository cursor has passed it', async () => {
  const h = harness({ repositories: { 'acme/widgets': { notifications: [] } } })
  await h.start()
  await h.round()
  await h.next()
  h.gh.script.repositories['acme/widgets']!.notifications = [notification(A, 7)]
  h.gh.script.repositories['acme/widgets']!.issues = {
    7: issue(A, 7, {
      body: '@agent-bot please look',
      user: { login: 'bob', type: 'User' },
      created_at: new Date(START + 30_000).toISOString(),
    }),
  }
  await h.next()
  await h.next()
  const bodies = h.rec.received.filter(
    item => item.trigger.meta.kind === 'issue' && item.trigger.threads[0]!.id === 'acme/widgets#7',
  )
  expect(bodies).toHaveLength(1)
})

it('does not ingest the body of an Issue created before the Source began when only a comment is new', async () => {
  const h = harness({
    repositories: {
      'acme/widgets': {
        notifications: [notification(A, 8)],
        issues: {
          8: issue(A, 8, {
            body: '@agent-bot old',
            user: { login: 'bob', type: 'User' },
            created_at: new Date(START - 60_000).toISOString(),
          }),
        },
        comments: {
          8: [
            comment(A, 8, 81, {
              created_at: new Date(START + 5_000).toISOString(),
              updated_at: new Date(START + 5_000).toISOString(),
            }),
          ],
        },
      },
    },
  })
  await h.start()
  await h.round()
  expect(
    h.rec.received.some(item => item.trigger.meta.kind === 'issue' && item.trigger.threads[0]!.id === 'acme/widgets#8'),
  ).toBe(false)
  expect(h.rec.received.some(item => item.trigger.threads[0]!.id === 'acme/widgets#8')).toBe(true)
})

it('an Issue read in two rounds yields one trigger and a duplicate on the second read', async () => {
  const h = harness({
    repositories: {
      'acme/widgets': {
        notifications: [notification(A, 9)],
        issues: {
          9: issue(A, 9, {
            body: '@agent-bot once',
            user: { login: 'bob', type: 'User' },
            created_at: new Date(START + 10_000).toISOString(),
          }),
        },
      },
    },
  })
  await h.start()
  await h.round()
  await h.next()
  const results = h.rec.received
    .filter(item => item.trigger.meta.kind === 'issue' && item.trigger.threads[0]!.id === 'acme/widgets#9')
    .map(item => item.result)
  expect(results).toEqual(['stored', 'duplicate'])
})

it('notifications polling takes interval, rate limit and next page from response headers, and a 304 fails the round', async () => {
  const gh = fakeGh({
    repositories: {
      [A]: {
        notificationHeaders: {
          'x-poll-interval': '120',
          'x-ratelimit-remaining': '42',
          'x-ratelimit-reset': '1790000123',
        },
        notificationPages: [[notification(A, 1)], [notification(A, 2)]],
        issues: { 1: issue(A, 1), 2: issue(A, 2) },
      },
    },
  })
  const source = githubSource({ repositories: [A], commands: gh.commands })
  const rec = recordingHost(source.kind)
  const poll = {
    repository: A,
    login: AGENT,
    commands: gh.commands,
    signal: new AbortController().signal,
    now: () => START,
  }
  expect(await pollRepository(rec.context, poll)).toBe(120)
  expect(gh.requests.some(r => r.method === 'GET' && r.path === 'repos/acme/widgets/issues/1')).toBe(true)
  expect(gh.requests.some(r => r.method === 'GET' && r.path === 'repos/acme/widgets/issues/2')).toBe(true)
  expect(
    gh.requests.some(r => r.path.startsWith('repos/acme/widgets/notifications') && r.path.includes('page=2')),
  ).toBe(true)
  const health = rec.board.all[`github:${A}`]
  expect(health?.values).toMatchObject({ rateRemaining: '42', rateReset: '1790000123' })
  expect(health?.detail).toContain('2 notifications')
  expect(health?.detail).toContain('next poll ≥ 120s')
  gh.script.repositories[A]!.failures = { notifications: 304 }
  await expect(pollRepository(rec.context, poll)).rejects.toMatchObject({ code: 304 })
})
