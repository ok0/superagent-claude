/**
 * Retention and the health snapshot in the Runtime: an ended ticket past retention.endedTicketDays loses its worker
 * record and workspace on a pass, a person's later message on the thread prepares a new workspace, each pass writes
 * the health snapshot, and a reload applies a changed endedTicketDays without a restart.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConfigSchema, loadConfig } from '../src/app/config.ts'
import { KV } from '../src/app/kv.ts'
import { Runtime } from '../src/app/runtime.ts'
import { DAY_MS } from '../src/app/retention.ts'
import { WorkerStore } from '../src/executor/worker-store.ts'
import { FakeRuntime, type FakeScript } from '../src/runtimes/fake/runtime.ts'
import type { LogRecord } from '../src/sources/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { trigger } from './fixtures/engine.ts'
import { testSource } from './fixtures/source.ts'

const ready: FakeScript = ({ index }) =>
  index === 0
    ? { tools: [{ name: 'orchestrator_report', args: { state: 'ready', summary: 'Done: the fake worker finished' } }] }
    : {}
const mention = trigger('1', { addressed: 'mention', meta: { repository: 'owner/repo' } })

const dirs: string[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'retention-runtime-'))
  dirs.push(dir)
  return dir
}

function config(stateDir: string) {
  return ConfigSchema.parse({
    repositories: ['owner/repo'],
    policy: { allowed: ['alice'], acceptMode: 'auto' },
    stateDir,
  })
}

it('cleans an ended ticket after endedTicketDays and prepares a new workspace when a person resumes it', async () => {
  const stateDir = directory()
  let offset = 0
  const chat = testSource()
  const fake = new FakeRuntime(ready)
  const records: LogRecord[] = []
  const runtime = new Runtime({
    config: config(stateDir),
    runtime: fake,
    kinds: [chat.kind],
    services: [chat.service],
    now: () => Date.now() + offset,
    log: record => {
      records.push(record)
    },
  })
  runtimes.push(runtime)
  await runtime.start()
  expect(chat.emit(mention)).toBe('stored')
  await waitUntil(() => runtime.store.tickets.list()[0]?.ended !== undefined)

  const id = runtime.store.tickets.list()[0]!.id
  const workers = new WorkerStore(runtime.store)
  const workDir = join(stateDir, 'work', id)
  expect(workers.get(id)).toBeDefined()
  expect(existsSync(workDir)).toBe(true)

  offset += 15 * DAY_MS
  await runtime.passes.pump()
  await runtime.passes.idle()
  await waitUntil(() => workers.get(id) === undefined && !existsSync(workDir))
  expect(records).toContainEqual(expect.objectContaining({ event: 'retention.cleaned', ticketId: id }))

  expect(chat.emit(trigger('2', { meta: { repository: 'owner/repo' } }))).toBe('stored')
  await waitUntil(() => fake.opened.length === 2 && existsSync(workDir) && workers.get(id) !== undefined)
  expect(fake.opened[1]!.resume).toBeUndefined()
})

it('writes the health snapshot each pass', async () => {
  let offset = 0
  const runtime = new Runtime({
    config: config(directory()),
    runtime: new FakeRuntime(() => ({})),
    now: () => Date.now() + offset,
  })
  runtimes.push(runtime)
  await runtime.start()
  await runtime.passes.idle()
  offset += 10_000
  await runtime.passes.pump()
  await runtime.passes.idle()
  expect(runtime.store.get(KV.health.snapshot)?.entries.runtime?.state).toBe('ready')
})

it('a reload applies a changed retention.endedTicketDays without asking for a restart', async () => {
  const dir = directory()
  const path = join(dir, 'issuecrew.json')
  const env = { HOME: '/home/test' }
  const write = (days: number): void => {
    writeFileSync(
      path,
      JSON.stringify({
        repositories: ['owner/repo'],
        policy: { allowed: ['alice'], acceptMode: 'auto' },
        security: { allowUnsandboxed: true },
        stateDir: join(dir, 'state'),
        retention: { endedTicketDays: days },
      }),
    )
  }
  write(14)
  const runtime = new Runtime({
    config: loadConfig(path, env),
    configPath: path,
    env,
    runtime: new FakeRuntime(() => ({}), { probe: { sandbox: true, version: 'x' } }),
  })
  runtimes.push(runtime)
  await runtime.start()

  write(3)
  const outcome = await runtime.reload()
  expect(outcome.applied).toBe(true)
  expect(outcome.restartRequired).not.toContain('retention')
  expect(runtime.config.retention.endedTicketDays).toBe(3)
})
