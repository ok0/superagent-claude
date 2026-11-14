/**
 * Startup order: the agent's child cleanup runs and finishes before restart recovery starts,
 * and a stopped child is logged.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/app/config.ts'
import { Runtime } from '../src/app/runtime.ts'
import { FakeRuntime, type FakeScript } from '../src/runtimes/fake/runtime.ts'
import type { LogRecord } from '../src/sources/host.ts'
import { testSource } from './fixtures/source.ts'

const order = vi.hoisted(() => [] as string[])

vi.mock('../src/executor/recovery.ts', async importOriginal => {
  const m = await importOriginal<typeof import('../src/executor/recovery.ts')>()
  return {
    ...m,
    recover: (h: Parameters<typeof m.recover>[0]) => {
      order.push('recover')
      return m.recover(h)
    },
  }
})

const ENV: Record<string, string | undefined> = { HOME: '/home/test' }
const hold: FakeScript = () => ({ hold: new Promise(() => {}) })

let dir: string
let runtime: Runtime | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runtime-children-'))
  order.length = 0
})

afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('runtime start', () => {
  it('stops recorded children before recovery and logs them', async () => {
    const path = join(dir, 'issuecrew.json')
    writeFileSync(
      path,
      JSON.stringify({
        repositories: ['owner/repo'],
        policy: { allowed: ['alice'], acceptMode: 'auto' },
        security: { allowUnsandboxed: true },
        stateDir: join(dir, 'state'),
      }),
    )
    const config = loadConfig(path, ENV)
    const chat = testSource()
    const records: LogRecord[] = []
    const fake = new FakeRuntime(hold, { probe: { sandbox: true, version: 'x' } })
    Object.assign(fake, {
      reap: async () => {
        order.push('reap:start')
        await new Promise(resolve => setTimeout(resolve, 20))
        order.push('reap:end')
        return [4242]
      },
    })
    const r = new Runtime({
      config,
      configPath: path,
      env: ENV,
      runtime: fake,
      kinds: [chat.kind],
      services: [chat.service],
      log: record => {
        records.push(record)
      },
    })
    runtime = r
    await r.start()
    expect(order.slice(0, 3)).toEqual(['reap:start', 'reap:end', 'recover'])
    expect(records).toContainEqual(expect.objectContaining({ event: 'runtime.children_stopped' }))
  })
})
