/**
 * Config reload while the Runtime runs: a policy change reaches open tickets as a policy-changed input without cancelling them, a refused file keeps the running config, rule violations refuse the whole change, startup-only keys are kept and reported, prompts are refreshed on success only, and SIGHUP reloads the daemon.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/app/config.ts'
import { allowedHash } from '../src/app/credentials.ts'
import { Runtime } from '../src/app/runtime.ts'
import { main } from '../src/cli/main.ts'
import type { Trigger } from '../src/core/index.ts'
import { ticketStage } from '../src/core/stage.ts'
import { SettingsSchema } from '../src/policy/policy.ts'
import { FakeRuntime, type FakeScript } from '../src/runtimes/fake/runtime.ts'
import type { LogRecord } from '../src/sources/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { cliEnv, cliIo } from './fixtures/cli.ts'
import { trigger } from './fixtures/engine.ts'
import { testSource } from './fixtures/source.ts'

const ENV: Record<string, string | undefined> = { HOME: '/home/test' }
const hold: FakeScript = () => ({ hold: new Promise(() => {}) })

let dir: string
let path: string
let runtime: Runtime | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reload-'))
  path = join(dir, 'superagent-claude.json')
})

afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  rmSync(dir, { recursive: true, force: true })
})

function writeConfig(over: Record<string, unknown> = {}): void {
  writeFileSync(path, JSON.stringify({
    repositories: ['owner/repo'],
    policy: { allowed: ['alice'], acceptMode: 'auto' },
    security: { allowUnsandboxed: true },
    stateDir: join(dir, 'state'),
    ...over,
  }))
}

async function boot(over: Record<string, unknown> = {}, agentLogin?: () => string | undefined) {
  writeConfig(over)
  const config = loadConfig(path, ENV)
  const chat = testSource()
  const records: LogRecord[] = []
  const fake = new FakeRuntime(hold, { probe: { sandbox: true, version: 'x' } })
  const r = new Runtime({
    config, configPath: path, env: ENV, runtime: fake, kinds: [chat.kind], services: [chat.service],
    log: record => { records.push(record) }, ...(agentLogin ? { agentLogin } : {}),
  })
  runtime = r
  await r.start()
  expect(chat.emit(from('1', 'alice'))).toBe('stored')
  await waitUntil(() => fake.sessions.length === 1 && r.store.tickets.open().length === 1)
  return { r, chat, fake, records }
}

function from(id: string, actor: string, repository = 'owner/repo'): Trigger {
  return trigger(id, {
    actor: { source: 'chat', id: actor }, addressed: 'mention', meta: { repository },
    threads: [{ source: 'chat', id: `t${id}` }], channel: { source: 'chat', thread: `t${id}`, address: { message: id } },
  })
}

describe('policy reload', () => {
  it('a policy change keeps the ticket open, adds a policy-changed input, and applies the new allowed list to the next Trigger', async () => {
    const { r, chat, records } = await boot()
    const spy = vi.spyOn(r.engine, 'policyChanged')
    expect(chat.emit(from('2', 'bob'))).toBe('filtered')

    const rules = SettingsSchema.parse({}).policy.rules.map(rule => rule.id === 'copy' ? { ...rule, enabled: false } : rule)
    writeConfig({ policy: { allowed: ['alice', 'bob'], acceptMode: 'auto', rules } })
    expect(await r.reload()).toMatchObject({ applied: true, policyChanged: true })
    expect(spy).toHaveBeenCalledTimes(1)

    const [ticket] = r.store.tickets.list()
    expect(r.store.tickets.open()).toHaveLength(1)
    expect(ticket!.inputs.some(input => input.kind === 'policy-changed')).toBe(true)
    expect(chat.emit(from('3', 'bob'))).toBe('stored')
    expect(records).toContainEqual(expect.objectContaining({ event: 'config.reloaded' }))
  })

  it('the same policy, with allowed reordered, gives no policyChanged', async () => {
    const { r } = await boot({ policy: { allowed: ['alice', 'bob'], acceptMode: 'auto' } })
    const spy = vi.spyOn(r.engine, 'policyChanged')
    writeConfig({ policy: { allowed: ['bob', 'alice'], acceptMode: 'auto' } })
    expect(await r.reload()).toMatchObject({ applied: true, policyChanged: false })
    expect(spy).not.toHaveBeenCalled()
  })

  it('a file that fails the schema keeps the running config, and a later valid file applies again', async () => {
    const { r, records } = await boot()
    writeFileSync(path, JSON.stringify({ repositories: [] }))
    const refused = await r.reload()
    expect(refused).toMatchObject({ applied: false })
    expect(refused.error).toBeDefined()
    expect(r.config.policy.allowed).toEqual(['alice'])
    expect(r.board.all.config?.state).toBe('error')
    expect(records).toContainEqual(expect.objectContaining({ event: 'config.reload_failed' }))

    writeFileSync(path, '{ not json')
    expect(await r.reload()).toMatchObject({ applied: false })

    writeConfig()
    expect(await r.reload()).toMatchObject({ applied: true, policyChanged: false })
    expect(r.board.all.config?.state).toBe('ready')
  })

  it('an empty allowed list is refused by the schema', async () => {
    const { r } = await boot()
    writeConfig({ policy: { allowed: [], acceptMode: 'auto' } })
    expect(await r.reload()).toMatchObject({ applied: false })
    expect(r.config.policy.allowed).toEqual(['alice'])
  })

  it('an agent account on the allowed list is refused by rule 4 on reload', async () => {
    const { r, chat } = await boot({}, () => 'agent-bot')
    writeConfig({ policy: { allowed: ['alice', 'agent-bot'], acceptMode: 'auto' } })
    const outcome = await r.reload()
    expect(outcome).toMatchObject({ applied: false })
    expect(outcome.error).toContain('rule 4')
    expect(r.config.policy.allowed).toEqual(['alice'])
    expect(chat.emit(from('2', 'agent-bot'))).toBe('filtered')
  })

  it('a subscription shared with others is refused without consent, and applied with consent, which is recorded', async () => {
    const { r, chat, records } = await boot({ auth: { mode: 'subscription', owner: 'alice' } })
    writeConfig({ auth: { mode: 'subscription', owner: 'alice' }, policy: { allowed: ['alice', 'bob'], acceptMode: 'auto' } })
    const refused = await r.reload()
    expect(refused).toMatchObject({ applied: false })
    expect(refused.error).toContain('ToS risk')
    expect(chat.emit(from('2', 'bob'))).toBe('filtered')

    writeConfig({ auth: { mode: 'subscription', owner: 'alice', acceptSubscriptionSharedUseRisk: true }, policy: { allowed: ['alice', 'bob'], acceptMode: 'auto' } })
    expect(await r.reload()).toMatchObject({ applied: true })
    const first = records.filter(record => record.event === 'auth.consent')
    expect(first.at(-1)).toMatchObject({ allowedHash: allowedHash(['alice', 'bob']) })
    expect(r.board.all.auth?.values?.allowedHash).toBe(allowedHash(['alice', 'bob']))
    expect(r.board.all.auth?.values?.consentAt).toBeDefined()

    writeConfig({ auth: { mode: 'subscription', owner: 'alice', acceptSubscriptionSharedUseRisk: true }, policy: { allowed: ['alice', 'bob', 'carol'], acceptMode: 'auto' } })
    expect(await r.reload()).toMatchObject({ applied: true })
    const second = records.filter(record => record.event === 'auth.consent')
    expect(second).toHaveLength(first.length + 1)
    expect(second.at(-1)).toMatchObject({ allowedHash: allowedHash(['alice', 'bob', 'carol']) })
    expect(allowedHash(['alice', 'bob', 'carol'])).not.toBe(allowedHash(['alice', 'bob']))
  })

  it('refreshes the worker prompts on a successful reload only', async () => {
    const { r } = await boot()
    const spy = vi.spyOn(r, 'refreshPrompts')
    writeConfig()
    await r.reload()
    expect(spy).toHaveBeenCalledTimes(1)
    writeFileSync(path, '{')
    await r.reload()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('keeps startup-only keys and reports them, and a repository change applies to admission now', async () => {
    const { r, chat, records } = await boot()
    writeConfig({ workers: { max: 3 }, stateDir: join(dir, 'other'), auth: { mode: 'bedrock' } })
    const outcome = await r.reload()
    expect(outcome).toMatchObject({ applied: true })
    expect(outcome.restartRequired).toEqual(expect.arrayContaining(['workers', 'stateDir', 'auth.mode']))
    expect(r.config.workers.max).toBe(2)
    expect(r.config.stateDir).toBe(join(dir, 'state'))
    expect(r.config.auth.mode).toBe('api-key')
    expect(records).toContainEqual(expect.objectContaining({ event: 'config.restart_required' }))

    writeConfig({ repositories: ['owner/repo', 'owner/other'] })
    const widened = await r.reload()
    expect(widened.warnings).toContain('Repository list changes apply to admission now; polling targets change on restart')
    expect(chat.emit(from('5', 'alice', 'owner/other'))).toBe('stored')
  })
})

it('the CLI reloads on SIGHUP, and the listener is removed when the daemon stops', async () => {
  writeConfig()
  const c = cliIo(dir, cliEnv(dir))
  const p = main(['start', '--fake', '--config', path], c.io)
  await waitUntil(() => c.out.join('').includes('"runtime.started"'), 10_000)
  writeConfig({ policy: { allowed: ['alice', 'bob'], acceptMode: 'auto' } })
  c.listeners.SIGHUP!()
  await waitUntil(() => c.out.join('').includes('"config.reloaded"'), 10_000)
  c.listeners.SIGINT!()
  expect(await p).toBe(0)
  expect(c.listeners.SIGHUP).toBeUndefined()
}, 30_000)

describe('worker session options on reload', () => {
  it('passes models.worker and network.allow to worker sessions and applies a reload to sessions opened after it', async () => {
    const { r, chat, fake } = await boot({ models: { worker: 'model-a' }, network: { allow: ['registry.npmjs.org'] } })
    expect(fake.sessions[0]!.spec.model).toBe('model-a')
    expect(fake.sessions[0]!.spec.network.allow).toEqual(['registry.npmjs.org'])

    writeConfig({ models: { worker: 'model-b' }, network: { allow: ['example.org'] } })
    const outcome = await r.reload()
    expect(outcome).toMatchObject({ applied: true })
    expect(outcome.restartRequired).not.toContain('network')
    expect(outcome.restartRequired).not.toContain('models.worker')

    expect(chat.emit(from('2', 'alice'))).toBe('stored')
    await waitUntil(() => fake.sessions.length === 2)
    expect(fake.sessions[1]!.spec.model).toBe('model-b')
    expect(fake.sessions[1]!.spec.network.allow).toEqual(['example.org'])
    expect(fake.sessions[0]!.spec.model).toBe('model-a')
  })

  it('omits the model option when models.worker is not set', async () => {
    const { fake } = await boot()
    expect('model' in fake.sessions[0]!.spec).toBe(false)
    expect(fake.sessions[0]!.spec.network.allow).toEqual([])
  })
})

it('a reload that lowers the limits leaves existing reports alone', async () => {
  const { r, records } = await boot()
  const id = r.store.tickets.open()[0]!.id
  r.engine.bindThread(id, { source: 'chat', id: 'pr' }, true)
  r.engine.report(id, { state: 'ready', summary: 'PR opened' })
  const kept = structuredClone(r.store.tickets.get(id)!.assignments)
  writeConfig({ workers: { max: 2, maxTurns: 1, maxBudgetUsd: 0.01 } })
  expect(await r.reload()).toMatchObject({ applied: true })
  expect(records).toContainEqual(expect.objectContaining({ event: 'config.restart_required', keys: expect.arrayContaining(['workers']) }))
  expect(r.store.tickets.get(id)!.assignments).toEqual(kept)
  expect(records.some(record => record.event === 'worker.limit')).toBe(false)
  expect(ticketStage(r.store.tickets.get(id)!)).toEqual({ stage: 'person', action: 'review' })
})
