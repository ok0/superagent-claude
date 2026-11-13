import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { delimiter } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { daemonEnv, ghShim, SHIM_EXIT, type GhShim } from './live/gh-shim.ts'

describe('gh shim', () => {
  let shim: GhShim | undefined
  afterEach(() => {
    if (shim) rmSync(shim.dir, { recursive: true, force: true })
    shim = undefined
  })

  it('records a call and fails it', () => {
    shim = ghShim()
    const result = spawnSync('gh', ['api', 'user'], { env: daemonEnv({ PATH: '/nonexistent' }, shim) })
    expect(result.status).toBe(SHIM_EXIT)
    const calls = shim.calls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/^\d+ api user$/)
  })

  it('starts with no calls', () => {
    shim = ghShim()
    expect(shim.calls()).toEqual([])
  })

  it('puts the shim first and leaves the base env alone', () => {
    shim = ghShim()
    const processPath = process.env.PATH
    const base = { PATH: '/usr/bin', HOME: '/h' }
    const env = daemonEnv(base, shim)
    expect(env.PATH).toBe(shim.bin + delimiter + '/usr/bin')
    expect(env.HOME).toBe('/h')
    expect(base.PATH).toBe('/usr/bin')
    expect(process.env.PATH).toBe(processPath)
  })
})
