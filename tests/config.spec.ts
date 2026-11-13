import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_FILE, ConfigError, StartupRefused, branchesOf, loadConfig, settingsOf } from '../src/app/config.ts'
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
      policy: {
        allowed: ['alice'],
        acceptMode: 'observe',
        rules: SettingsSchema.parse({}).policy.rules,
        admission: {},
      },
      auth: { mode: 'api-key', acceptSubscriptionSharedUseRisk: false },
      delivery: { allowAutoMerge: false },
      workers: { max: 2, maxTurns: 100, maxBudgetUsd: 5 },
      network: { allow: [] },
      security: {
        trustRepoConfig: false,
        allowUnsandboxed: false,
        weakerNestedSandbox: false,
        allowLocalBinding: true,
      },
      retention: { endedTicketDays: 14 },
      models: {},
      review: { enabled: true, minChangedLines: 50, maxPerTicket: 3 },
      stateDir: '/home/test/.superagent-claude',
    })
  })

  it('loads every key of the full schema', () => {
    const path = write({
      repositories: ['owner/repo'],
      policy: {
        allowed: ['alice'],
        acceptMode: 'auto',
        rules: SettingsSchema.parse({}).policy.rules.slice(0, 1),
        admission: {},
      },
      auth: { mode: 'subscription', owner: 'Alice', acceptSubscriptionSharedUseRisk: true },
      delivery: { allowAutoMerge: true },
      workers: { max: 3, maxTurns: 50, maxBudgetUsd: 2 },
      network: { allow: ['example.com'] },
      security: { trustRepoConfig: true, allowUnsandboxed: true, weakerNestedSandbox: true, allowLocalBinding: false },
      retention: { endedTicketDays: 7 },
      models: { router: 'r', worker: 'w' },
      review: { enabled: false, minChangedLines: 10, maxPerTicket: 1 },
      stateDir: 'state',
    })
    const config = loadConfig(path, ENV)
    expect(config.review).toEqual({ enabled: false, minChangedLines: 10, maxPerTicket: 1 })
    expect(config.auth).toEqual({ mode: 'subscription', owner: 'Alice', acceptSubscriptionSharedUseRisk: true })
    expect(config.delivery).toEqual({ allowAutoMerge: true })
    expect(config.network).toEqual({ allow: ['example.com'] })
    expect(config.security).toEqual({
      trustRepoConfig: true,
      allowUnsandboxed: true,
      weakerNestedSandbox: true,
      allowLocalBinding: false,
    })
    expect(config.retention).toEqual({ endedTicketDays: 7 })
    expect(config.models).toEqual({ router: 'r', worker: 'w' })
    expect(config.policy.rules).toHaveLength(1)
    expect(config.policy.admission).toEqual({})
    expect(config.policy.acceptMode).toBe('auto')
  })

  it('rejects delivery.forkWhenNoPush, which was removed', () => {
    expect(() =>
      loadConfig(
        write({ repositories: ['owner/repo'], policy: { allowed: ['alice'] }, delivery: { forkWhenNoPush: true } }),
        ENV,
      ),
    ).toThrow(ConfigError)
  })

  it('rejects an unknown delivery key', () => {
    expect(() =>
      loadConfig(
        write({ repositories: ['owner/repo'], policy: { allowed: ['alice'] }, delivery: { autoMerge: true } }),
        ENV,
      ),
    ).toThrow(ConfigError)
  })

  it('refuses unknown nested keys and wrong types with the key path', () => {
    const base = { repositories: ['owner/repo'], policy: { allowed: ['alice'] } }
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, auth: { mode: 'api-key', extra: 1 } }, 'auth'],
      [{ ...base, auth: { mode: 'magic' } }, 'auth.mode'],
      [{ ...base, security: { allowUnsandboxed: 'yes' } }, 'security.allowUnsandboxed'],
      [{ ...base, security: { weakerNestedSandbox: 'yes' } }, 'security.weakerNestedSandbox'],
      [{ ...base, security: { allowLocalBinding: 'yes' } }, 'security.allowLocalBinding'],
      [{ ...base, security: { allowLocalBinding: 1 } }, 'security.allowLocalBinding'],
      [{ ...base, network: { allow: 'x' } }, 'network.allow'],
      [{ ...base, review: { minChangedLines: 0 } }, 'review.minChangedLines'],
      [{ ...base, review: { minChangedLines: -1 } }, 'review.minChangedLines'],
      [{ ...base, review: { maxPerTicket: 1.5 } }, 'review.maxPerTicket'],
      [{ ...base, review: { enabled: 'yes' } }, 'review.enabled'],
      [{ ...base, review: { extra: 1 } }, 'review'],
    ]
    for (const [value, text] of cases) {
      const path = write(value)
      let caught: unknown
      try {
        loadConfig(path, ENV)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(StartupRefused)
      expect(caught).toBeInstanceOf(ConfigError)
      expect((caught as StartupRefused).rule).toBe('config')
      expect((caught as Error).message).toContain(text)
    }
  })

  it('policyVersion is stable for the same policy and changes with it', () => {
    const load = (over: Record<string, unknown>, allowed: string[] = ['alice', 'Bob']) =>
      settingsOf(
        loadConfig(
          write({
            repositories: ['owner/repo'],
            policy: { allowed, ...((over.policy as object) ?? {}) },
            ...(over.top as object),
          }),
          ENV,
        ),
      )
    const version = policyVersion(load({}))
    expect(policyVersion(load({}, ['Bob', 'alice']))).toBe(version)
    expect(policyVersion(load({}, ['alice']))).not.toBe(version)
    expect(policyVersion(load({ policy: { acceptMode: 'auto' } }))).not.toBe(version)
    const rules = SettingsSchema.parse({}).policy.rules.map(rule => ({
      ...rule,
      enabled: rule.id === 'copy' ? false : rule.enabled,
    }))
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

  it('normalizes object repository entries into repositories and branch settings', () => {
    const path = write({
      repositories: [
        'owner/a',
        { repository: 'owner/b', branchFrom: 'main', pullRequestTo: 'dev' },
        { repository: 'Owner/C' },
      ],
      policy: { allowed: ['alice'] },
    })
    const config = loadConfig(path, ENV)
    expect(config.repositories).toEqual(['owner/a', 'owner/b', 'Owner/C'])
    expect(config.branches).toEqual({ 'owner/b': { branchFrom: 'main', pullRequestTo: 'dev' } })
    expect(branchesOf(config, 'OWNER/B')).toEqual({ branchFrom: 'main', pullRequestTo: 'dev' })
    expect(branchesOf(config, 'owner/a')).toEqual({})
  })

  it('string-only entries have no branch settings', () => {
    const config = loadConfig(write({ repositories: ['owner/repo'], policy: { allowed: ['alice'] } }), ENV)
    expect(config.branches).toBeUndefined()
    expect(branchesOf(config, 'owner/repo')).toEqual({})
  })

  it.each([
    ['a repository listed twice in different case', { repositories: ['owner/repo', 'Owner/Repo'] }, 'more than once'],
    ['a repository listed as string and object', { repositories: ['owner/repo', { repository: 'owner/repo' }] }, ''],
    ['an unknown branch key', { repositories: [{ repository: 'owner/repo', base: 'dev' }] }, ''],
    ['a branchFrom starting with a dash', { repositories: [{ repository: 'owner/repo', branchFrom: '-x' }] }, ''],
    ['a branchFrom containing ..', { repositories: [{ repository: 'owner/repo', branchFrom: 'a..b' }] }, ''],
    ['a pullRequestTo ending in .lock', { repositories: [{ repository: 'owner/repo', pullRequestTo: 'x.lock' }] }, ''],
    ['an empty pullRequestTo', { repositories: [{ repository: 'owner/repo', pullRequestTo: '' }] }, ''],
    ['an empty branchFrom', { repositories: [{ repository: 'owner/repo', branchFrom: '' }] }, ''],
  ])('refuses %s', (_label, over, text) => {
    const path = write({ policy: { allowed: ['alice'] }, ...over })
    expect(() => loadConfig(path, ENV)).toThrow(ConfigError)
    if (text) expect(() => loadConfig(path, ENV)).toThrow(text)
  })
})
