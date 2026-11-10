/** The assembled daemon with the GitHub Source over the fake gh and the fake runtime: an allowed sender's mention gets exactly one reply in its repository. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConfigSchema, StartupRefused } from '../src/app/config.ts'
import { Runtime } from '../src/app/runtime.ts'
import { installedSources } from '../src/app/sources.ts'
import { FakeRuntime, type FakeScript } from '../src/runtimes/fake/runtime.ts'
import { githubChannel } from '../src/sources/github/trigger.ts'
import { waitUntil } from './fixtures/async.ts'
import { ManualClock } from './fixtures/executor.ts'
import { fakeGh, issue, notification, START } from './fixtures/fake-gh.ts'

const A = 'acme/widgets'
const B = 'acme/gadgets'

let runtime: Runtime | undefined
let directory: string | undefined

afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

const ready: FakeScript = ({ index }) => index === 0
  ? { tools: [{ name: 'orchestrator_report', args: { state: 'ready', summary: 'Done: the fake worker finished' } }] }
  : {}

it('auto: a mentioned issue gets one reply in its own repository, and re-polling or re-sending adds none', async () => {
  directory = mkdtempSync(join(tmpdir(), 'github-runtime-'))
  const config = ConfigSchema.parse({ repositories: [A, B], policy: { allowed: ['alice'], acceptMode: 'auto' }, stateDir: directory })
  const gh = fakeGh({
    repositories: {
      [A]: { notifications: [notification(A, 1)], issues: { 1: issue(A, 1, { body: '@agent-bot please fix the typo' }) } },
      [B]: { issues: { 1: issue(B, 1) } },
    },
  })
  const clock = new ManualClock(START)
  const sources = installedSources(config, { SUPERAGENT_CLAUDE_GITHUB_TOKEN: 'test-token' }, { commands: gh.commands, timers: clock, now: clock.now })
  expect(sources.kinds.map(k => k.kind)).toEqual(['github'])
  runtime = new Runtime({ config, runtime: new FakeRuntime(ready), ...sources })
  await runtime.start()

  await waitUntil(() => gh.posted.length === 1)
  await runtime.passes.idle()
  expect(gh.posted[0]).toMatchObject({ repository: A, path: 'issues/1/comments' })
  expect(gh.posted[0]!.body.startsWith('Done: the fake worker finished')).toBe(true)
  expect(runtime.store.tickets.list()).toHaveLength(1)

  await waitUntil(() => clock.pending === 1)
  clock.advance(60_000)
  await waitUntil(() => gh.calls.filter(call => call.startsWith('repos/acme/widgets/notifications')).length === 2)
  await runtime.passes.idle()
  expect(gh.posted).toHaveLength(1)
  expect(runtime.store.tickets.list()).toHaveLength(1)

  const id = /<!-- superagent-claude:(.+) -->/.exec(gh.posted[0]!.body)![1]!
  expect(runtime.store.receipts.get(id)!.status).toBe('sent')
  runtime.outbox.send({ id, channel: githubChannel(A, 1, `https://github.com/${A}/issues/1`), text: 'again', kind: 'reply' })
  await runtime.outbox.sent()
  expect(gh.posted).toHaveLength(1)
})

it('refuses startup without the token', () => {
  directory = mkdtempSync(join(tmpdir(), 'github-runtime-'))
  const config = ConfigSchema.parse({ repositories: [A], policy: { allowed: ['alice'] }, stateDir: directory })
  expect(() => installedSources(config, {})).toThrow(StartupRefused)
  expect(() => installedSources(config, { SUPERAGENT_CLAUDE_GITHUB_TOKEN: '  ' })).toThrow(StartupRefused)
  try {
    installedSources(config, {})
  } catch (error) {
    expect((error as StartupRefused).rule).toBe('agent-token')
  }
})
