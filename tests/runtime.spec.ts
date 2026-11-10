/**
 * The Runtime's lifecycle: stop within its timeout, stop giving up after it, restart with recovery after a restart, the single-process lock, and start with no Source.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConfigSchema } from '../src/app/config.ts'
import { Runtime, STOP_TIMEOUT_MS } from '../src/app/runtime.ts'
import { FakeRuntime, type FakeScript } from '../src/runtimes/fake/runtime.ts'
import type { LogRecord } from '../src/sources/host.ts'
import { sleep, waitUntil } from './fixtures/async.ts'
import { trigger } from './fixtures/engine.ts'
import { testSource } from './fixtures/source.ts'

const hold: FakeScript = () => ({ hold: new Promise(() => {}) })
const ready: FakeScript = ({ index }) => index === 0
  ? { tools: [{ name: 'orchestrator_report', args: { state: 'ready', summary: 'Done: the fake worker finished' } }] }
  : {}
const mention = trigger('1', { addressed: 'mention' })

const dirs: string[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-'))
  dirs.push(dir)
  return dir
}

function config(stateDir: string, mode: 'off' | 'observe' | 'auto' = 'auto') {
  return ConfigSchema.parse({ repositories: ['owner/repo'], policy: { allowed: ['alice'], acceptMode: mode }, stateDir })
}

async function boot(stateDir: string, script: FakeScript) {
  const chat = testSource()
  const fake = new FakeRuntime(script)
  const records: LogRecord[] = []
  const runtime = new Runtime({ config: config(stateDir), runtime: fake, kinds: [chat.kind], services: [chat.service], log: record => { records.push(record) } })
  runtimes.push(runtime)
  await runtime.start()
  return { runtime, chat, fake, records }
}

it('stop finishes within the timeout and leaves no session open', async () => {
  const { runtime, chat, fake, records } = await boot(directory(), hold)
  expect(chat.emit(mention)).toBe('stored')
  await waitUntil(() => fake.active === 1)

  const t0 = Date.now()
  await runtime.stop()
  expect(Date.now() - t0).toBeLessThan(STOP_TIMEOUT_MS)
  expect(fake.active).toBe(0)
  expect(chat.stops()).toBe(1)

  const opened = fake.opened.length
  await sleep(50)
  expect(fake.opened.length).toBe(opened)
  await runtime.stop()
  expect(records.at(-1)).toMatchObject({ event: 'runtime.stopped', level: 'info' })
  expect(() => chat.emit(mention)).toThrow()
})

it('stop gives up waiting after the stop timeout', async () => {
  const records: LogRecord[] = []
  const runtime = new Runtime({
    config: config(directory()), runtime: new FakeRuntime(() => ({})),
    services: [{ kind: 'stuck', start: async () => {}, stop: () => new Promise(() => {}) }],
    stopTimeoutMs: 200, log: record => { records.push(record) },
  })
  runtimes.push(runtime)
  await runtime.start()
  const t0 = Date.now()
  await runtime.stop()
  expect(Date.now() - t0).toBeLessThan(2000)
  expect(records.at(-1)).toMatchObject({ event: 'runtime.stopped', level: 'warn' })
})

it('a new Runtime on the same state directory restarts the running Assignment with the recovery note', async () => {
  const stateDir = directory()
  const first = await boot(stateDir, hold)
  expect(first.chat.emit(mention)).toBe('stored')
  await waitUntil(() => first.fake.active === 1)
  await waitUntil(() => first.runtime.store.tickets.list()[0]?.assignments.at(-1)?.state === 'running')
  await first.runtime.stop()

  const chat2 = testSource()
  const fake2 = new FakeRuntime(ready)
  const second = new Runtime({ config: config(stateDir), runtime: fake2, kinds: [chat2.kind], services: [chat2.service] })
  runtimes.push(second)
  await second.start()
  await waitUntil(() => chat2.sent.some(message => message.kind === 'reply'))

  const tickets = second.store.tickets.list()
  expect(tickets).toHaveLength(1)
  expect(tickets[0]!.assignments[0]).toMatchObject({ state: 'ended', endedReason: 'hostRestarted' })
  expect(fake2.sessions[0]!.sent[0]!.text).toContain('The host restarted')
})

it('a second Runtime on a running state directory is refused', async () => {
  const stateDir = directory()
  const { runtime } = await boot(stateDir, hold)
  expect(() => new Runtime({ config: config(stateDir), runtime: new FakeRuntime(() => ({})) })).toThrow(/Another superagent-claude process/)
  await runtime.stop()
})

it('starts with no Source registered', async () => {
  const records: LogRecord[] = []
  const runtime = new Runtime({ config: config(directory()), runtime: new FakeRuntime(() => ({})), log: record => { records.push(record) } })
  runtimes.push(runtime)
  await runtime.start()
  expect(records).toContainEqual(expect.objectContaining({ event: 'runtime.started', sources: [] }))
  await runtime.stop()
})
