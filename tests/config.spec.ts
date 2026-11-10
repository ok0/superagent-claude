import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_FILE, ConfigError, StartupRefused, loadConfig, settingsOf } from '../src/app/config.ts'
import { SettingsSchema, policyVersion } from '../src/policy/policy.ts'

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
      policy: { allowed: ['alice'], acceptMode: 'observe', rules: SettingsSchema.parse({}).policy.rules, admission: {} },
      auth: { mode: 'api-key', acceptSubscriptionSharedUseRisk: false },
      delivery: { forkWhenNoPush: true },
      workers: { max: 2, maxTurns: 100, maxBudgetUsd: 5 },
      network: { allow: [] },
      security: { trustRepoConfig: false, allowUnsandboxed: false },
      retention: { endedTicketDays: 14 },
      models: {},
      stateDir: '/home/test/.superagent-claude',
    })
  })

  it('loads every key of the full schema', () => {
    const path = write({
      repositories: ['owner/repo'],
      policy: { allowed: ['alice'], acceptMode: 'auto', rules: SettingsSchema.parse({}).policy.rules.slice(0, 1), admission: {} },
      auth: { mode: 'subscription', owner: 'Alice', acceptSubscriptionSharedUseRisk: true },
      delivery: { forkWhenNoPush: false },
      workers: { max: 3, maxTurns: 50, maxBudgetUsd: 2 },
      network: { allow: ['example.com'] },
      security: { trustRepoConfig: true, allowUnsandboxed: true },
      retention: { endedTicketDays: 7 },
      models: { router: 'r', worker: 'w' },
      stateDir: 'state',
    })
    const config = loadConfig(path, ENV)
    expect(config.auth).toEqual({ mode: 'subscription', owner: 'Alice', acceptSubscriptionSharedUseRisk: true })
    expect(config.delivery).toEqual({ forkWhenNoPush: false })
    expect(config.network).toEqual({ allow: ['example.com'] })
    expect(config.security).toEqual({ trustRepoConfig: true, allowUnsandboxed: true })
    expect(config.retention).toEqual({ endedTicketDays: 7 })
    expect(config.models).toEqual({ router: 'r', worker: 'w' })
    expect(config.policy.rules).toHaveLength(1)
    expect(config.policy.admission).toEqual({})
    expect(config.policy.acceptMode).toBe('auto')
  })

  it('refuses unknown nested keys and wrong types with the key path', () => {
    const base = { repositories: ['owner/repo'], policy: { allowed: ['alice'] } }
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, auth: { mode: 'api-key', extra: 1 } }, 'auth'],
      [{ ...base, auth: { mode: 'magic' } }, 'auth.mode'],
      [{ ...base, security: { allowUnsandboxed: 'yes' } }, 'security.allowUnsandboxed'],
      [{ ...base, network: { allow: 'x' } }, 'network.allow'],
    ]
    for (const [value, text] of cases) {
      const path = write(value)
      let caught: unknown
      try { loadConfig(path, ENV) } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(StartupRefused)
      expect(caught).toBeInstanceOf(ConfigError)
      expect((caught as StartupRefused).rule).toBe('config')
      expect((caught as Error).message).toContain(text)
    }
  })

  it('policyVersion is stable for the same policy and changes with it', () => {
    const load = (over: Record<string, unknown>, allowed: string[] = ['alice', 'Bob']) => settingsOf(loadConfig(write({
      repositories: ['owner/repo'], policy: { allowed, ...(over.policy as object ?? {}) }, ...over.top as object,
    }), ENV))
    const version = policyVersion(load({}))
    expect(policyVersion(load({}, ['Bob', 'alice']))).toBe(version)
    expect(policyVersion(load({}, ['alice']))).not.toBe(version)
    expect(policyVersion(load({ policy: { acceptMode: 'auto' } }))).not.toBe(version)
    const rules = SettingsSchema.parse({}).policy.rules.map(rule => ({ ...rule, enabled: rule.id === 'copy' ? false : rule.enabled }))
    expect(policyVersion(load({ policy: { rules } }))).not.toBe(version)
    expect(policyVersion(load({ top: { workers: { max: 4 } } }))).toBe(version)
    expect(policyVersion(load({ top: { stateDir: '/elsewhere' } }))).toBe(version)
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

    const extraKey = write({ repositories: ['owner/repo'], policy: { allowed: ['alice'] }, bogus: {} })
    expect(() => loadConfig(extraKey, ENV)).toThrow('bogus')

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
