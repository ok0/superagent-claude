/** Session-mode daemon over the fake gh with real git worktrees: publish opens one PR and binds it; a PR follow-up comment reaches the same ticket, worktree, branch and session, and the next publish only pushes. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConfigSchema } from '../src/app/config.ts'
import { Runtime } from '../src/app/runtime.ts'
import { installedSources } from '../src/app/sources.ts'
import { WorkerStore } from '../src/executor/worker-store.ts'
import { FakeRuntime, type FakeReaction, type FakeScript, type FakeTurn } from '../src/runtimes/fake/runtime.ts'
import type { LogRecord } from '../src/sources/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { ManualClock } from './fixtures/executor.ts'
import { comment, fakeGh, issue, notification, START } from './fixtures/fake-gh.ts'

const A = 'acme/widgets'
const ACK = 'I will look into the typo.'
const RESULT = 'The typo is fixed in the readme.'
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
      tools.push({ name: 'orchestrator_route', args: { decisions: [{ kind: 'accept', trigger_id: relay.trigger_id, title: 'Fix the typo', worktree_name: 'fix-typo', acknowledgement: ACK }] } })
    } else if (relay.kind === 'worker_report' && relay.state === 'ready') {
      tools.push({ name: 'orchestrator_reply', args: { ticket_id: (relay.ticket as { ticket_id: string }).ticket_id, purpose: 'result', text: RESULT } })
    }
  }
  return tools.length > 0 ? { tools } : undefined
}

function commit(turn: FakeTurn, env: Record<string, string>, file: string): void {
  writeFileSync(join(turn.spec.cwd, file), file + '\n')
  execFileSync('git', ['add', '-A'], { cwd: turn.spec.cwd, env, encoding: 'utf8' })
  execFileSync('git', [...COMMIT, 'commit', '-m', 'Fix ' + file], { cwd: turn.spec.cwd, env, encoding: 'utf8' })
}

function workerScript(env: Record<string, string>): FakeScript {
  return (turn: FakeTurn): FakeReaction => {
    const publish = { name: 'orchestrator_publish', args: { title: 'Fix the typo', body: 'Fixes the typo.' } }
    if (turn.inputs.some(input => input.text.includes('second paragraph'))) {
      commit(turn, env, 'second.txt')
      return { tools: [publish, { name: 'orchestrator_report', args: { state: 'ready', summary: 'Pushed the follow-up.' } }] }
    }
    if (turn.index === 0) {
      commit(turn, env, 'typo.txt')
      return { tools: [publish, publish, { name: 'orchestrator_report', args: { state: 'ready', summary: 'Opened the pull request.' } }] }
    }
    return {}
  }
}

function start(log?: (record: LogRecord) => void): { gh: ReturnType<typeof fakeGh>; clock: ManualClock; fake: FakeRuntime; origin: string; env: Record<string, string> } {
  directory = mkdtempSync(join(tmpdir(), 'delivery-e2e-'))
  const env = { PATH: process.env.PATH!, HOME: join(directory, 'home'), LANG: 'C' }
  mkdirSync(env.HOME, { recursive: true })
  const sh = (args: string[], cwd: string): string => execFileSync('git', args, { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' })
  const origin = join(directory, 'origin.git')
  sh(['init', '--bare', '-b', 'main', origin], directory)
  const seed = join(directory, 'seed')
  sh(['init', '-b', 'main', seed], directory)
  writeFileSync(join(seed, 'README.md'), 'hello')
  sh(['add', '-A'], seed)
  sh([...COMMIT, 'commit', '-m', 'init'], seed)
  sh(['push', origin, 'main'], seed)

  const config = ConfigSchema.parse({ repositories: [A], policy: { allowed: ['alice'], acceptMode: 'auto' }, stateDir: join(directory, 'state') })
  const gh = fakeGh({
    repositories: {
      [A]: { notifications: [notification(A, 1)], issues: { 1: issue(A, 1, { body: '@agent-bot please fix the typo' }) } },
    },
  })
  const clock = new ManualClock(START)
  const sources = installedSources(config, { SUPERAGENT_CLAUDE_GITHUB_TOKEN: 'test-token' }, { commands: gh.commands, timers: clock, now: clock.now })
  const worker = workerScript(env)
  const fake = new FakeRuntime(turn => turn.spec.role === 'router' ? router(turn) : worker(turn))
  runtime = new Runtime({
    config, runtime: fake, router: 'session', workspaces: 'git', env, ...sources,
    access: { remote: () => origin, env: () => ({}), secrets: [] },
    ...(log ? { log } : {}),
  })
  return { gh, clock, fake, origin, env }
}

const publishResults = (session: { toolCalls: { name: string; result?: unknown }[] }): { pr: number; created: boolean; pushed_commits?: number }[] =>
  session.toolCalls.filter(call => call.name === 'orchestrator_publish' && call.result !== undefined).map(call => call.result as { pr: number; created: boolean; pushed_commits?: number })

it('publish twice opens one PR bound to the ticket, and a PR follow-up resumes the same worktree, branch and session and only pushes', async () => {
  const records: LogRecord[] = []
  const { gh, clock, fake, origin, env } = start(record => records.push(record))
  await runtime!.start()
  await waitUntil(() => fake.sessions.some(session => session.spec.role === 'worker' && publishResults(session).length === 2))

  const ticketId = runtime!.store.tickets.list()[0]!.id
  const worker = fake.sessions.find(session => session.spec.role === 'worker')!
  const [first, second] = publishResults(worker)
  expect(first!.pr).toBe(2)
  expect(second).toMatchObject({ published: true, pr: first!.pr, created: false })
  expect(gh.requests.filter(r => r.method === 'POST' && r.path === 'repos/acme/widgets/pulls')).toHaveLength(1)
  expect(runtime!.store.tickets.get(ticketId)!.follows).toContainEqual(expect.objectContaining({ thread: 'github:acme/widgets#2', own: true }))

  const record = new WorkerStore(runtime!.store, Date.now).get(ticketId)!
  const branch1 = record.branch
  const sessionId1 = worker.sessionId
  const cwd1 = worker.spec.cwd
  expect(execFileSync('git', ['rev-parse', `refs/heads/${branch1}`], { cwd: origin, env, encoding: 'utf8' }).trim())
    .toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: record.cwd, env, encoding: 'utf8' }).trim())
  const graphqlBefore = gh.graphql.length
  const evalsBefore = records.filter(item => item.event === 'eval.started').length

  const arrived = (): boolean => fake.sessions.some(session => session.spec.role === 'worker' && session.sent.some(input => input.text.includes('second paragraph')))
  await waitUntil(() => clock.pending >= 1)
  gh.script.repositories[A]!.comments = {
    2: [comment(A, 2, 601, {
      body: 'Please also check the second paragraph.',
      user: { login: 'alice', type: 'User' },
      created_at: new Date(Date.now() + 1000).toISOString(),
      updated_at: new Date(Date.now() + 1000).toISOString(),
    })],
  }
  clock.advance(60_000)
  for (let step = 0; step < 5 && !arrived(); step++) {
    await runtime!.passes.idle()
    if (arrived()) break
    await waitUntil(() => clock.pending >= 1)
    clock.advance(60_000)
  }
  await waitUntil(arrived)

  const receiving = fake.sessions.find(session => session.spec.role === 'worker' && session.sent.some(input => input.text.includes('second paragraph')))!
  await waitUntil(() => publishResults(receiving).length === 1)
  const third = publishResults(receiving)[0]!
  expect(third).toMatchObject({ published: true, pr: first!.pr, created: false, pushed_commits: 1 })
  expect(gh.requests.filter(r => r.method === 'POST' && r.path === 'repos/acme/widgets/pulls')).toHaveLength(1)
  expect(records.filter(item => item.event === 'eval.started')).toHaveLength(evalsBefore)
  expect(runtime!.store.tickets.list()).toHaveLength(1)

  const followUp = receiving.sent.find(input => input.text.includes('second paragraph'))!
  const triggerId = (JSON.parse(followUp.text) as { trigger_id: string }).trigger_id
  const disposition = runtime!.store.triggers.disposition(triggerId)!
  expect(disposition.evalId).toBeUndefined()
  expect(disposition.fanout).toContain(ticketId)

  expect(receiving.sessionId).toBe(sessionId1)
  expect(receiving.spec.cwd).toBe(cwd1)
  const after = new WorkerStore(runtime!.store, Date.now).get(ticketId)!
  expect(after.branch).toBe(branch1)
  expect(after.sessionId).toBe(sessionId1)
  expect(execFileSync('git', ['rev-list', '--count', `main..${branch1}`], { cwd: origin, env, encoding: 'utf8' }).trim()).toBe('2')

  expect(gh.requests.filter(r => r.method === 'PATCH' || r.method === 'PUT')).toHaveLength(0)
  expect(gh.graphql.length).toBe(graphqlBefore)
  const markers = gh.posted.map(post => /<!-- superagent-claude:(.+) -->/.exec(post.body)?.[1]).filter((id): id is string => id !== undefined)
  expect(new Set(markers).size).toBe(markers.length)
})
