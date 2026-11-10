import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_FILE, ConfigError, loadConfig, settingsOf } from '../src/app/config.ts'

const ENV = { HOME: '/home/test' }
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(value: unknown): string {
  const path = join(dir, CONFIG_FILE)
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

describe('config file', () => {
  it('loads a minimal file with the defaults', () => {
    const path = write({ repositories: ['owner/repo'], policy: { allowed: ['alice'] } })
    expect(loadConfig(path, ENV)).toEqual({
      repositories: ['owner/repo'],
      policy: { allowed: ['alice'], acceptMode: 'observe' },
      workers: { max: 2, maxTurns: 100, maxBudgetUsd: 5 },
      stateDir: '/home/test/.superagent-claude',
    })
  })

  it('resolves a relative stateDir against the config file directory', () => {
    const path = write({ repositories: ['owner/repo'], policy: { allowed: ['alice'] }, stateDir: 'state' })
    expect(loadConfig(path, ENV).stateDir).toBe(join(dir, 'state'))
  })

  it('refuses a missing file', () => {
    const path = join(dir, CONFIG_FILE)
    expect(() => loadConfig(path, ENV)).toThrow(ConfigError)
    expect(() => loadConfig(path, ENV)).toThrow('Config file not found')
  })

  it('refuses a file that is not JSON', () => {
    const path = write('{')
    expect(() => loadConfig(path, ENV)).toThrow('is not valid JSON')
  })

  it('refuses a schema violation', () => {
    const invalidWorkers = write({ repositories: ['owner/repo'], policy: { allowed: ['alice'] }, workers: { max: 0 } })
    expect(() => loadConfig(invalidWorkers, ENV)).toThrow('workers.max')

    const extraKey = write({ repositories: ['owner/repo'], policy: { allowed: ['alice'] }, auth: {} })
    expect(() => loadConfig(extraKey, ENV)).toThrow('auth')

    const missingRepositories = write({ policy: { allowed: ['alice'] } })
    expect(() => loadConfig(missingRepositories, ENV)).toThrow('repositories')
  })

  it('refuses an empty repositories list', () => {
    const path = write({ repositories: [], policy: { allowed: ['alice'] } })
    expect(() => loadConfig(path, ENV)).toThrow('repositories: must name at least one repository')
  })

  it('refuses an empty policy.allowed list', () => {
    const path = write({ repositories: ['owner/repo'], policy: { allowed: [] } })
    expect(() => loadConfig(path, ENV)).toThrow('policy.allowed: must name at least one login')
  })

  it('maps the policy part onto Settings', () => {
    const path = write({ repositories: ['owner/repo'], policy: { allowed: ['alice'], acceptMode: 'auto' } })
    const settings = settingsOf(loadConfig(path, ENV))
    expect(settings.policy.allowed).toEqual(['alice'])
    expect(settings.policy.acceptMode).toBe('auto')
    expect(settings.paused).toBe(false)
    expect(settings.eval.timeoutSeconds).toBe(120)
    expect(settings.policy.rules.map(rule => rule.id)).toEqual(['copy', 'visual'])
  })
})
