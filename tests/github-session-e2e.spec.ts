/**
 * The assembled daemon in session mode with the GitHub Source over the fake gh: the Router session accepts
 * a mention, the host posts the acknowledgement, the Router posts the result, and re-polling or re-sending
 * adds no comment.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConfigSchema } from '../src/app/config.ts'
import { Runtime } from '../src/app/runtime.ts'
import { installedSources } from '../src/app/sources.ts'
import { FakeRuntime, type FakeScript } from '../src/runtimes/fake/runtime.ts'
import type { LogRecord } from '../src/sources/host.ts'
import { githubChannel } from '../src/sources/github/trigger.ts'
import { waitUntil } from './fixtures/async.ts'
import { ManualClock } from './fixtures/executor.ts'
import { comment, fakeGh, issue, notification, START } from './fixtures/fake-gh.ts'

const A = 'acme/widgets'
const ACK = 'I will look into the typo.'
const RESULT = 'The typo is fixed in the readme.'

let runtime: Runtime | undefined
let directory: string | undefined

afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function relaysIn(inputs: { text: string }[]): Record<string, unknown>[] {
  const relays: Record<string, unknown>[] = []
  for (const input of inputs) {
    try {
      relays.push(JSON.parse(input.text) as Record<string, unknown>)
    } catch {
      continue
    }
  }
  return relays
}

const router: FakeScript = ({ inputs }) => {
  const tools: { name: string; args: unknown }[] = []
  for (const relay of relaysIn(inputs)) {
    if (relay.kind === 'candidate') {
      tools.push({
        name: 'orchestrator_route',
        args: {
          decisions: [
            {
              kind: 'accept',
              trigger_id: relay.trigger_id,
              title: 'Fix the typo',
              worktree_name: 'fix-typo',
              acknowledgement: ACK,
            },
          ],
        },
      })
    } else if (relay.kind === 'worker_report' && relay.state === 'ready') {
      tools.push({
        name: 'orchestrator_reply',
        args: { ticket_id: (relay.ticket as { ticket_id: string }).ticket_id, purpose: 'result', text: RESULT },
      })
    }
  }
  return tools.length > 0 ? { tools } : undefined
}

const worker: FakeScript = ({ index }) =>
  index === 0
    ? { tools: [{ name: 'orchestrator_report', args: { state: 'ready', summary: 'Worker summary text' } }] }
    : {}

function start(
  workerScript: FakeScript,
  log?: (record: LogRecord) => void,
): {
  gh: ReturnType<typeof fakeGh>
  clock: ManualClock
  fake: FakeRuntime
  config: ReturnType<typeof ConfigSchema.parse>
} {
  directory = mkdtempSync(join(tmpdir(), 'github-session-e2e-'))
  const config = ConfigSchema.parse({
    repositories: [A],
    policy: { allowed: ['alice'], acceptMode: 'auto' },
    stateDir: directory,
  })
  const gh = fakeGh({
    repositories: {
      [A]: {
        notifications: [notification(A, 1)],
        issues: { 1: issue(A, 1, { body: '@agent-bot please fix the typo' }) },
      },
    },
  })
  const clock = new ManualClock(START)
  const sources = installedSources(
    config,
    { ISSUECREW_GITHUB_TOKEN: 'test-token' },
    { commands: gh.commands, timers: clock, now: clock.now },
  )
  const fake = new FakeRuntime(turn => (turn.spec.role === 'router' ? router(turn) : workerScript(turn)))
  runtime = new Runtime({ config, runtime: fake, router: 'session', ...sources, ...(log ? { log } : {}) })
  return { gh, clock, fake, config }
}

it('session mode: a mentioned issue gets one acknowledgement and one result from the Router, and re-polling or re-sending adds none', async () => {
  const { gh, clock } = start(worker)
  await runtime!.start()

  await waitUntil(() => gh.posted.length === 2)
  await runtime!.passes.idle()
  expect(gh.posted[0]).toMatchObject({ repository: A, path: 'issues/1/comments' })
  expect(gh.posted[1]).toMatchObject({ repository: A, path: 'issues/1/comments' })
  expect(gh.posted[0]!.body.startsWith(ACK)).toBe(true)
  expect(gh.posted[1]!.body.startsWith(RESULT)).toBe(true)
  expect(gh.posted.some(post => post.body.startsWith('Worker summary text'))).toBe(false)
  expect(runtime!.store.tickets.list()).toHaveLength(1)

  const ids = gh.posted.map(post => /<!-- issuecrew:(.+) -->/.exec(post.body)![1]!)
  expect(ids[0]).not.toBe(ids[1])
  for (const id of ids) expect(runtime!.store.receipts.get(id)!.status).toBe('sent')

  await waitUntil(() => clock.pending === 1)
  clock.advance(60_000)
  await waitUntil(() => gh.calls.filter(call => call.startsWith('repos/acme/widgets/notifications')).length === 2)
  await runtime!.passes.idle()
  expect(gh.posted).toHaveLength(2)
  expect(runtime!.store.tickets.list()).toHaveLength(1)

  for (const id of ids) {
    runtime!.outbox.send({
      id,
      channel: githubChannel(A, 1, `https://github.com/${A}/issues/1`),
      text: 'again',
      kind: 'reply',
    })
  }
  await runtime!.outbox.sent()
  expect(gh.posted).toHaveLength(2)
})

it('session mode: a follow-up comment by the allowed user on the issue reaches the ticket worker without a new Eval or ticket', async () => {
  const records: LogRecord[] = []
  const { gh, clock, fake } = start(
    () => ({}),
    record => records.push(record),
  )
  await runtime!.start()
  await waitUntil(
    () => runtime!.store.tickets.list().length === 1 && fake.sessions.some(session => session.spec.role === 'worker'),
  )
  const evalsBefore = records.filter(record => record.event === 'eval.started').length

  const candidatesBefore = fake.sessions
    .filter(session => session.spec.role === 'router')
    .flatMap(session => relaysIn(session.sent))
    .filter(relay => relay.kind === 'candidate').length

  gh.script.repositories[A]!.comments = {
    1: [
      comment(A, 1, 501, {
        body: 'Please also check the second paragraph.',
        user: { login: 'alice', type: 'User' },
        created_at: new Date(clock.now() + 1000).toISOString(),
        updated_at: new Date(clock.now() + 1000).toISOString(),
      }),
    ],
  }
  await waitUntil(() => clock.pending >= 1)
  clock.advance(60_000)
  const arrived = (): boolean =>
    fake.sessions.some(
      session => session.spec.role === 'worker' && session.sent.some(input => input.text.includes('second paragraph')),
    )
  for (let step = 0; step < 5 && !arrived(); step++) {
    await runtime!.passes.idle()
    if (arrived()) break
    await waitUntil(() => clock.pending >= 1)
    clock.advance(60_000)
  }
  await waitUntil(arrived)

  expect(records.filter(record => record.event === 'eval.started')).toHaveLength(evalsBefore)
  expect(runtime!.store.tickets.list()).toHaveLength(1)

  const candidatesAfter = fake.sessions
    .filter(session => session.spec.role === 'router')
    .flatMap(session => relaysIn(session.sent))
    .filter(relay => relay.kind === 'candidate').length
  expect(candidatesAfter).toBe(candidatesBefore)
  expect(gh.posted.every(post => !post.body.startsWith('Worker summary text'))).toBe(true)
})
