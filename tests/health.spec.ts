/** The exec probe: health --live/--ready over the state database and lock, in process. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { healthCommand } from '../src/cli/health.ts'
import { loadConfig } from '../src/app/config.ts'
import { KV } from '../src/app/kv.ts'
import { Runtime } from '../src/app/runtime.ts'
import { databasePath, Store } from '../src/app/store.ts'
import { openReadOnly } from '../src/app/store-read.ts'
import { FakeRuntime } from '../src/runtimes/fake/runtime.ts'
import { cliEnv, cliIo } from './fixtures/cli.ts'

const dirs: string[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => {})
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'health-'))
  dirs.push(dir)
  const cfg = join(dir, 'issuecrew.json')
  writeFileSync(
    cfg,
    JSON.stringify({ repositories: ['owner/repo'], policy: { allowed: ['alice'] }, stateDir: join(dir, 'state') }),
  )
  const c = cliIo(dir, cliEnv(dir))
  const boot = async (): Promise<Runtime> => {
    const runtime = new Runtime({ config: loadConfig(cfg, c.io.env), runtime: new FakeRuntime(() => ({})) })
    runtimes.push(runtime)
    await runtime.start()
    return runtime
  }
  const check = (mode: 'live' | 'ready', now?: () => number): number =>
    healthCommand([`--${mode}`, '--config', cfg], c.io, now)
  return { dir, cfg, c, boot, check }
}

describe('health', () => {
  it('fails live and ready without a state database', () => {
    const t = setup()
    expect(t.check('live')).toBe(1)
    expect(t.check('ready')).toBe(1)
    expect(t.c.err.join('')).toContain('no state database')
  })

  it('fails live and ready when no process holds the state lock', async () => {
    const t = setup()
    const runtime = await t.boot()
    await runtime.stop()
    expect(t.check('live')).toBe(1)
    expect(t.check('ready')).toBe(1)
  })

  it('passes live and ready once the runtime has started', async () => {
    const t = setup()
    await t.boot()
    expect(t.check('live')).toBe(0)
    expect(t.check('ready')).toBe(0)
    expect(t.c.out.join('')).toBe('live\nready\n')
  })

  it('fails ready as soon as stop begins while live still passes', async () => {
    const t = setup()
    const runtime = await t.boot()
    const stopping = runtime.stop()
    expect(t.check('ready')).toBe(1)
    expect(t.check('live')).toBe(0)
    await stopping
  })

  it('fails live and ready on a health snapshot older than 60 seconds', async () => {
    const t = setup()
    await t.boot()
    const now = () => Date.now() + 61_000
    expect(t.check('live', now)).toBe(1)
    expect(t.check('ready', now)).toBe(1)
    expect(t.c.err.join('')).toContain('health snapshot')
  })

  it('fails when the state lock is recorded on another host', async () => {
    const t = setup()
    await t.boot()
    writeFileSync(`${databasePath(join(t.dir, 'state'))}.owner`, `${process.pid} other-host`)
    expect(t.check('live')).toBe(1)
    expect(t.c.err.join('')).toContain('held on host other-host')
  })

  it('a new runtime clears the readiness marker of the process before it', async () => {
    const t = setup()
    const db = databasePath(join(t.dir, 'state'))
    const s = new Store(db)
    s.set(KV.runtime.ready, { pid: process.pid, at: new Date().toISOString() })
    s.close()
    runtimes.push(new Runtime({ config: loadConfig(t.cfg, t.c.io.env), runtime: new FakeRuntime(() => ({})) }))
    const reader = openReadOnly(db)
    try {
      expect(reader.get(KV.runtime.ready)).toBeUndefined()
    } finally {
      reader.close()
    }
  })

  it('refuses bad arguments with exit code 2', () => {
    const t = setup()
    expect(healthCommand([], t.c.io)).toBe(2)
    expect(healthCommand(['--live', '--ready'], t.c.io)).toBe(2)
    expect(healthCommand(['--bogus'], t.c.io)).toBe(2)
  })
})
