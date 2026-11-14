/**
 * Session-mode daemon over the fake gh with real git worktrees on a repository the agent account cannot write:
 * events, replies and worktrees work, publish returns published: false with no push, PR or bind and the worker
 * reports blocked; an event from an unlisted repository is rejected.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConfigSchema } from '../src/app/config.ts'
import { Runtime } from '../src/app/runtime.ts'
import { installedSources } from '../src/app/sources.ts'
import { humanTextProblem } from '../src/app/tools/tool.ts'
import { WorkerStore } from '../src/executor/worker-store.ts'
import { FakeRuntime, type FakeReaction, type FakeScript, type FakeTurn } from '../src/runtimes/fake/runtime.ts'
import { GITHUB_STATE } from '../src/sources/github/source.ts'
import { issueTrigger } from '../src/sources/github/trigger.ts'
import { waitUntil } from './fixtures/async.ts'
import { WRITE_ACCESS_NOTE_LEAD } from '../src/app/prompts.ts'
import { ManualClock } from './fixtures/executor.ts'
import { AGENT, fakeGh, issue, notification, START, type FakeGh, type FakeRepository } from './fixtures/fake-gh.ts'

const A = 'acme/widgets'
const ACK = 'I will look into the typo.'
const QUESTION = 'Could a person give the agent account write access to acme/widgets?'
const COMMIT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']

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
    }
  }
  return tools.length > 0 ? { tools } : undefined
}

function commit(turn: FakeTurn, env: Record<string, string>, file: string): void {
  writeFileSync(join(turn.spec.cwd, file), file + '\n')
  execFileSync('git', ['add', '-A'], { cwd: turn.spec.cwd, env, encoding: 'utf8' })
  execFileSync('git', [...COMMIT, 'commit', '-m', 'Fix ' + file], { cwd: turn.spec.cwd, env, encoding: 'utf8' })
}

function workerScript(env: Record<string, string>, beforePublish?: () => void): FakeScript {
  return (turn: FakeTurn): FakeReaction => {
    const publish = { name: 'orchestrator_publish', args: { title: 'Fix the typo', body: 'Fixes the typo.' } }
    if (turn.index === 0) {
      commit(turn, env, 'typo.txt')
      beforePublish?.()
      return {
        tools: [
          publish,
          {
            name: 'orchestrator_report',
            args: {
              state: 'blocked',
              summary: 'The agent account cannot push to acme/widgets.',
              human_action: QUESTION,
            },
          },
        ],
      }
    }
    return {}
  }
}

function start(
  access: FakeRepository['access'],
  worker: (env: Record<string, string>, gh: FakeGh) => FakeScript,
): { gh: FakeGh; clock: ManualClock; fake: FakeRuntime; origin: string; env: Record<string, string> } {
  directory = mkdtempSync(join(tmpdir(), 'readonly-delivery-e2e-'))
  const env = { PATH: process.env.PATH!, HOME: join(directory, 'home'), LANG: 'C' }
  mkdirSync(env.HOME, { recursive: true })
  const sh = (args: string[], cwd: string): string =>
    execFileSync('git', args, { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' })
  const origin = join(directory, 'origin.git')
  sh(['init', '--bare', '-b', 'main', origin], directory)
  const seed = join(directory, 'seed')
  sh(['init', '-b', 'main', seed], directory)
  writeFileSync(join(seed, 'README.md'), 'hello')
  sh(['add', '-A'], seed)
  sh([...COMMIT, 'commit', '-m', 'init'], seed)
  sh(['push', origin, 'main'], seed)

  const config = ConfigSchema.parse({
    repositories: [A],
    policy: { allowed: ['alice'], acceptMode: 'auto' },
    stateDir: join(directory, 'state'),
  })
  const gh = fakeGh({
    repositories: {
      [A]: {
        access,
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
  const workerTurns = worker(env, gh)
  const fake = new FakeRuntime(turn => (turn.spec.role === 'router' ? router(turn) : workerTurns(turn)))
  runtime = new Runtime({
    config,
    runtime: fake,
    router: 'session',
    workspaces: 'git',
    env,
    ...sources,
    access: { remote: () => origin, env: () => ({}), secrets: [] },
  })
  return { gh, clock, fake, origin, env }
}

const publishResults = (session: { toolCalls: { name: string; result?: unknown }[] }): Record<string, unknown>[] =>
  session.toolCalls
    .filter(call => call.name === 'orchestrator_publish' && call.result !== undefined)
    .map(call => call.result as Record<string, unknown>)

const latestReport = () => {
  const ticket = runtime!.store.tickets.list()[0]
  return ticket?.assignments.at(-1)?.report
}

it('without write access: ticket, acknowledgement and worktree work; publish returns published false; the worker reports blocked', async () => {
  const { gh, fake, origin, env } = start({ push: false }, env => workerScript(env))
  await runtime!.start()
  await waitUntil(
    () =>
      fake.sessions.some(session => session.spec.role === 'worker' && publishResults(session).length === 1) &&
      latestReport()?.state === 'blocked',
  )

  const tickets = runtime!.store.tickets.list()
  expect(tickets).toHaveLength(1)
  const ticketId = tickets[0]!.id
  expect(gh.posted.some(post => post.body.includes(ACK))).toBe(true)

  const record = new WorkerStore(runtime!.store, Date.now).get(ticketId)!
  expect(existsSync(join(record.cwd, '.git'))).toBe(true)
  expect(record.branch.startsWith('agent/')).toBe(true)

  const worker = fake.sessions.find(session => session.spec.role === 'worker')!
  const [result] = publishResults(worker)
  expect(result).toMatchObject({ published: false, recorded_at_startup: 'no push' })
  expect(String(result!.reason)).toContain('acme/widgets')
  expect(worker.sent.filter(input => input.text.includes(WRITE_ACCESS_NOTE_LEAD + ' ' + A))).toHaveLength(1)
  expect(gh.requests.filter(r => r.path.startsWith('repos/acme/widgets/pulls'))).toHaveLength(0)
  expect(execFileSync('git', ['for-each-ref', 'refs/heads/agent'], { cwd: origin, env, encoding: 'utf8' }).trim()).toBe(
    '',
  )
  expect(runtime!.store.tickets.get(ticketId)?.follows?.some(item => item.own)).not.toBe(true)

  const report = latestReport()!
  expect(report.state).toBe('blocked')
  const ticket = runtime!.store.tickets.get(ticketId)!
  expect(ticket.attention?.question).toBe(QUESTION)
  expect(humanTextProblem(QUESTION)).toBeUndefined()

  expect(runtime!.store.get(GITHUB_STATE.access(A))).toMatchObject({ accessible: true, push: false })
  const entry = runtime!.board.snapshot(new Date().toISOString()).entries['github:' + A]
  expect(entry?.state).not.toBe('error')
  expect(entry?.values?.push).toBe('false')
})

it('a startup record of push is overridden when push is gone at publish time', async () => {
  const { gh, fake, origin, env } = start({ push: true }, (env, gh) =>
    workerScript(env, () => {
      gh.script.repositories[A]!.access = { push: false }
    }),
  )
  await runtime!.start()
  await waitUntil(
    () =>
      fake.sessions.some(session => session.spec.role === 'worker' && publishResults(session).length === 1) &&
      latestReport()?.state === 'blocked',
  )

  const worker = fake.sessions.find(session => session.spec.role === 'worker')!
  const [result] = publishResults(worker)
  expect(result).toMatchObject({ published: false, recorded_at_startup: 'push' })
  for (const session of fake.sessions.filter(s => s.spec.role === 'worker')) {
    expect(session.sent.filter(input => input.text.includes(WRITE_ACCESS_NOTE_LEAD)).length).toBe(0)
  }
  expect(gh.requests.filter(r => r.method === 'POST' && r.path === 'repos/acme/widgets/pulls')).toHaveLength(0)
  expect(execFileSync('git', ['for-each-ref', 'refs/heads/agent'], { cwd: origin, env, encoding: 'utf8' }).trim()).toBe(
    '',
  )
  expect(latestReport()!.state).toBe('blocked')
})

it('an event from an unlisted repository is rejected without a ticket or launch', async () => {
  const { fake } = start({ push: false }, env => workerScript(env))
  await runtime!.start()
  await waitUntil(() => runtime!.store.tickets.list().length === 1)

  const workerCount = (): number => fake.sessions.filter(session => session.spec.role === 'worker').length
  const ticketCount = runtime!.store.tickets.list().length
  await waitUntil(() => workerCount() === 1)
  const workersBefore = workerCount()
  const trigger = issueTrigger(
    {
      number: 7,
      title: 'x',
      body: '@agent-bot fix it',
      user: { login: 'alice', type: 'User' },
      created_at: new Date().toISOString(),
      html_url: 'https://github.com/other/widgets/issues/7',
    } as never,
    'other/widgets',
    AGENT,
  )
  const result = runtime!.context('github').receive(trigger)
  await runtime!.passes.idle()
  expect(result).toBe('filtered')
  expect(runtime!.store.rejected.get(trigger.id)?.reason).toBe('rejected-repo')
  expect(runtime!.store.tickets.list()).toHaveLength(ticketCount)
  expect(workerCount()).toBe(workersBefore)
})
