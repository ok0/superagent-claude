/**
 * The startup rules: credential mode, policy and agent-account refusals, the subscription consent and shared-use
 * warning, the sandbox rule, repository access, and the same checks through the GitHub Source hook and the CLI
 * (exit code 2).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, ConfigSchema, loadConfig, StartupRefused, type Config } from '../src/app/config.ts'
import {
  allowedHash,
  assertAgentLogin,
  assertRepositoryAccess,
  assertStartupPolicy,
  resolveCredential,
  SHARED_USE_WARNING,
  SUBSCRIPTION_POLICY_WARNING,
  UNSANDBOXED_WARNING,
} from '../src/app/credentials.ts'
import { installedSources } from '../src/app/sources.ts'
import { main } from '../src/cli/main.ts'
import type { SourceService } from '../src/sources/host.ts'
import type { RuntimeProbe } from '../src/executor/contract.ts'
import { waitUntil } from './fixtures/async.ts'
import { cliEnv, cliIo, fakeGhBin, installFakeFetch } from './fixtures/cli.ts'
import { ManualClock } from './fixtures/executor.ts'
import { fakeGh, issue, recordingHost, START } from './fixtures/fake-gh.ts'

const A = 'acme/widgets'
const B = 'acme/gadgets'
const dirs: string[] = []
const services: SourceService[] = []

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop().catch(() => {})
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'startup-policy-'))
  dirs.push(dir)
  return dir
}

const cfg = (over: Record<string, unknown>): Config =>
  ConfigSchema.parse({ repositories: ['owner/repo'], policy: { allowed: ['owner'] }, ...over })

function refusal(work: () => unknown): StartupRefused {
  try {
    work()
  } catch (error) {
    if (error instanceof StartupRefused) return error
    throw error
  }
  throw new Error('expected a startup refusal')
}

const sandboxed: RuntimeProbe = { sandbox: true, version: 'x' }
const unsandboxed: RuntimeProbe = { sandbox: false, version: 'x' }

describe('startup rules', () => {
  it('rule 1: the credential must match auth.mode and be present', () => {
    expect(refusal(() => assertStartupPolicy(cfg({}), { mode: 'bedrock' })).rule).toBe('credential')
    expect(refusal(() => resolveCredential('api-key', {})).rule).toBe('credential')
    expect(refusal(() => resolveCredential('api-key', {})).message).toContain('Startup refused (credential): ')
  })

  it('rule 2: an empty policy.allowed is refused, and the file loader refuses it too', () => {
    const base = cfg({})
    const empty: Config = { ...base, policy: { ...base.policy, allowed: [] } }
    const error = refusal(() => assertStartupPolicy(empty, { mode: 'api-key' }))
    expect(error.rule).toBe('allowed-empty')
    expect(error.message).toContain('Startup refused (allowed-empty): ')
    expect(error.message).not.toMatch(/rule \d/)

    const dir = tempDir()
    const path = join(dir, 'superagent-claude.json')
    writeFileSync(path, JSON.stringify({ repositories: ['owner/repo'], policy: { allowed: [] } }))
    expect(() => loadConfig(path, {})).toThrow(ConfigError)
  })

  it('rule 3: an empty repositories list is refused', () => {
    const error = refusal(() => assertStartupPolicy({ ...cfg({}), repositories: [] }, { mode: 'api-key' }))
    expect(error.rule).toBe('repositories-empty')
    expect(error.message).toContain('Startup refused (repositories-empty): ')
  })

  it('rule 4: the agent account may not be on policy.allowed, compared without case', () => {
    expect(refusal(() => assertStartupPolicy(cfg({}), { mode: 'api-key' }, 'OWNER')).rule).toBe('agent-allowed')
    expect(refusal(() => assertAgentLogin(cfg({}), 'owner'))).toBeInstanceOf(StartupRefused)
    expect(refusal(() => assertAgentLogin(cfg({}), 'owner')).message).toContain('Startup refused (agent-allowed): ')
    expect(() => assertStartupPolicy(cfg({}), { mode: 'api-key' }, 'agent-bot')).not.toThrow()
  })

  it('rule 6 (a): a subscription with people other than the owner is refused without consent', () => {
    const shared = cfg({ policy: { allowed: ['owner', 'mate'] }, auth: { mode: 'subscription', owner: 'owner' } })
    const error = refusal(() => assertStartupPolicy(shared, { mode: 'subscription' }))
    expect(error.rule).toBe('subscription-shared')
    expect(error.message).toContain(SHARED_USE_WARNING)
    expect(error.message).toContain('Startup refused (subscription-shared): ')

    const unowned = cfg({ policy: { allowed: ['owner', 'mate'] }, auth: { mode: 'subscription' } })
    expect(refusal(() => assertStartupPolicy(unowned, { mode: 'subscription' })).rule).toBe('subscription-shared')
  })

  it('rule 6 (b): with consent the shared-use warnings are returned and the consent is recorded', () => {
    const accepted = cfg({
      policy: { allowed: ['owner', 'mate'] },
      auth: { mode: 'subscription', owner: 'owner', acceptSubscriptionSharedUseRisk: true },
    })
    const now = () => Date.parse('2026-11-10T00:00:00Z')
    const report = assertStartupPolicy(accepted, { mode: 'subscription' }, undefined, undefined, now)
    expect(report.warnings).toEqual([SUBSCRIPTION_POLICY_WARNING, SHARED_USE_WARNING])
    expect(report.consent).toEqual({ at: '2026-11-10T00:00:00.000Z', allowedHash: allowedHash(['owner', 'mate']) })
    expect(allowedHash(['Mate', 'owner'])).toBe(allowedHash(['owner', 'mate']))
    expect(allowedHash(['owner', 'mate', 'third'])).not.toBe(allowedHash(['owner', 'mate']))
  })

  it('rule 6 (c): a subscription used only by its owner warns once and needs no consent', () => {
    const owned = cfg({ policy: { allowed: ['Owner'] }, auth: { mode: 'subscription', owner: 'owner' } })
    const report = assertStartupPolicy(owned, { mode: 'subscription' })
    expect(report.warnings).toEqual([SUBSCRIPTION_POLICY_WARNING])
    expect(report.consent).toBeUndefined()
  })

  it.each(['api-key', 'bedrock', 'vertex'] as const)(
    'rule 6 (d): %s with several people has no warning, no consent, and keeps acceptMode',
    mode => {
      const observe = cfg({ policy: { allowed: ['owner', 'mate'] }, auth: { mode } })
      expect(assertStartupPolicy(observe, { mode })).toEqual({ warnings: [] })
      expect(observe.policy.acceptMode).toBe('observe')
      const auto = cfg({ policy: { allowed: ['owner', 'mate'], acceptMode: 'auto' }, auth: { mode } })
      expect(assertStartupPolicy(auto, { mode })).toEqual({ warnings: [] })
      expect(auto.policy.acceptMode).toBe('auto')
    },
  )

  it('rule 7: auto acceptance without a sandbox is refused unless allowUnsandboxed is set', () => {
    const auto = cfg({ policy: { allowed: ['owner'], acceptMode: 'auto' } })
    const error = refusal(() => assertStartupPolicy(auto, { mode: 'api-key' }, undefined, unsandboxed))
    expect(error.rule).toBe('unsandboxed')
    expect(error.message).toContain('Startup refused (unsandboxed): ')
    expect(error.message).toContain('docs/deploy.md#sandbox-in-containers')
    expect(() =>
      assertStartupPolicy(
        cfg({ policy: { allowed: ['owner'], acceptMode: 'auto' }, security: { allowUnsandboxed: true } }),
        { mode: 'api-key' },
        undefined,
        unsandboxed,
      ),
    ).not.toThrow()
    expect(() => assertStartupPolicy(auto, { mode: 'api-key' }, undefined, sandboxed)).not.toThrow()
    expect(() => assertStartupPolicy(auto, { mode: 'api-key' })).not.toThrow()
  })

  it('allowUnsandboxed without a sandbox returns the unsandboxed warning', () => {
    const allowed = cfg({ policy: { allowed: ['owner'], acceptMode: 'auto' }, security: { allowUnsandboxed: true } })
    expect(assertStartupPolicy(allowed, { mode: 'api-key' }, undefined, unsandboxed).warnings).toEqual([
      UNSANDBOXED_WARNING,
    ])
    expect(assertStartupPolicy(allowed, { mode: 'api-key' }, undefined, sandboxed).warnings).toEqual([])
    const observe = cfg({ policy: { allowed: ['owner'], acceptMode: 'observe' }, security: { allowUnsandboxed: true } })
    expect(assertStartupPolicy(observe, { mode: 'api-key' }, undefined, unsandboxed).warnings).toContain(
      UNSANDBOXED_WARNING,
    )
  })

  it('rule 8: no accessible repository is refused, partial access is not', () => {
    const two = cfg({ repositories: ['a/b', 'c/d'] })
    expect(refusal(() => assertRepositoryAccess(two, [])).rule).toBe('no-repository')
    expect(refusal(() => assertRepositoryAccess(two, [])).message).toContain('Startup refused (no-repository): ')
    expect(() => assertRepositoryAccess(two, ['a/b'])).not.toThrow()
  })
})

describe('startup checks through the GitHub Source', () => {
  function sourcesFor(script: Parameters<typeof fakeGh>[0], allowed = ['alice'], clock = new ManualClock(START)) {
    const config = ConfigSchema.parse({ repositories: [A, B], policy: { allowed }, stateDir: '/unused' })
    const gh = fakeGh(script)
    const sources = installedSources(
      config,
      { SUPERAGENT_CLAUDE_GITHUB_TOKEN: 't' },
      { commands: gh.commands, timers: clock, now: clock.now },
    )
    return { sources, gh, clock }
  }

  it('rule 8: no accessible repository refuses start', async () => {
    const { sources } = sourcesFor({
      repositories: { [A]: { access: { status: 404 } }, [B]: { access: { status: 404 } } },
    })
    const service = sources.services[0]!
    services.push(service)
    const rec = recordingHost(sources.kinds[0]!)
    const error = await service.start(rec.host, new AbortController().signal).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(StartupRefused)
    expect((error as StartupRefused).rule).toBe('no-repository')
    expect((error as StartupRefused).message).toContain('Startup refused (no-repository): ')
  })

  it('rule 8: one inaccessible repository is reported in health and start resolves', async () => {
    const { sources } = sourcesFor({
      repositories: { [A]: { issues: { 1: issue(A, 1) } }, [B]: { access: { status: 404 } } },
    })
    const service = sources.services[0]!
    services.push(service)
    const rec = recordingHost(sources.kinds[0]!)
    await expect(service.start(rec.host, new AbortController().signal)).resolves.toBeUndefined()
    expect(rec.board.all[`github:${B}`]?.state).toBe('error')
  })

  it('agent-account: an unreadable agent account refuses start, and a missing token refuses installation', async () => {
    const { sources } = sourcesFor({ userStatus: 401, repositories: { [A]: {} } })
    const service = sources.services[0]!
    services.push(service)
    const rec = recordingHost(sources.kinds[0]!)
    const error = await service.start(rec.host, new AbortController().signal).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as StartupRefused).rule).toBe('agent-account')
    expect(() =>
      installedSources(ConfigSchema.parse({ repositories: [A], policy: { allowed: ['alice'] } }), {}),
    ).toThrow(StartupRefused)
  })

  it('rule 4 at the hook: an agent account on policy.allowed refuses start; a good start exposes the login', async () => {
    const refused = sourcesFor({ login: 'Owner', repositories: { [A]: {}, [B]: {} } }, ['owner']).sources
    const badService = refused.services[0]!
    services.push(badService)
    const badRec = recordingHost(refused.kinds[0]!)
    const error = await badService.start(badRec.host, new AbortController().signal).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as StartupRefused).rule).toBe('agent-allowed')

    const good = sourcesFor({ repositories: { [A]: {}, [B]: {} } }, ['owner']).sources
    const goodService = good.services[0]!
    services.push(goodService)
    const goodRec = recordingHost(good.kinds[0]!)
    await goodService.start(goodRec.host, new AbortController().signal)
    expect(good.agentLogin()).toBe('agent-bot')
  })
})

describe('startup refusals through the CLI', () => {
  function writeConfig(dir: string, extra: Record<string, unknown> = {}): string {
    const path = join(dir, 'superagent-claude.json')
    writeFileSync(
      path,
      JSON.stringify({
        repositories: ['owner/repo'],
        policy: { allowed: ['alice'] },
        stateDir: join(dir, 'state'),
        ...extra,
      }),
    )
    return path
  }

  it('a subscription with several people and no consent exits 2 with the ToS risk', async () => {
    const dir = tempDir()
    const path = writeConfig(dir, { policy: { allowed: ['owner', 'mate'] }, auth: { mode: 'subscription' } })
    const c = cliIo(dir, cliEnv(dir, { CLAUDE_CODE_OAUTH_TOKEN: 't' }))
    expect(await main(['start', '--fake', '--config', path], c.io)).toBe(2)
    expect(c.err.join('')).toContain('ToS risk')
  })

  it('a missing agent token exits 2 with agent-token', async () => {
    const dir = tempDir()
    const c = cliIo(dir, cliEnv(dir, { SUPERAGENT_CLAUDE_GITHUB_TOKEN: undefined }))
    expect(await main(['start', '--fake', '--config', writeConfig(dir)], c.io)).toBe(2)
    expect(c.err.join('')).toContain('agent-token')
  })

  it('a missing credential exits 2 with rule 1 and the variable name', async () => {
    const dir = tempDir()
    const c = cliIo(dir, cliEnv(dir, { ANTHROPIC_API_KEY: undefined }))
    expect(await main(['start', '--fake', '--config', writeConfig(dir)], c.io)).toBe(2)
    expect(c.err.join('')).toContain('ANTHROPIC_API_KEY')
    expect(c.err.join('')).toContain('Startup refused (credential): ')
  })

  it('auto acceptance without a sandbox exits 2 with rule 7; with allowUnsandboxed it starts and stops with 0', async () => {
    const dir = tempDir()
    const refused = cliIo(dir, cliEnv(dir))
    expect(
      await main(
        ['start', '--fake', '--config', writeConfig(dir, { policy: { allowed: ['alice'], acceptMode: 'auto' } })],
        refused.io,
      ),
    ).toBe(2)
    expect(refused.err.join('')).toContain('Startup refused (unsandboxed): ')
    expect(refused.err.join('')).toContain('docs/deploy.md#sandbox-in-containers')

    const allowed = cliIo(dir, cliEnv(dir))
    const p = main(
      [
        'start',
        '--fake',
        '--config',
        writeConfig(dir, { policy: { allowed: ['alice'], acceptMode: 'auto' }, security: { allowUnsandboxed: true } }),
      ],
      allowed.io,
    )
    await waitUntil(() => allowed.out.join('').includes('"runtime.started"'), 10_000)
    allowed.listeners.SIGINT!()
    expect(await p).toBe(0)
    expect(allowed.err.join('')).toContain('warning: security.allowUnsandboxed')
  }, 30_000)

  it('an agent account on policy.allowed exits 2 with rule 4', async () => {
    const dir = tempDir()
    const c = cliIo(dir, cliEnv(dir, { PATH: `${fakeGhBin(join(dir, 'alice'), { login: 'alice' })}:/usr/bin:/bin` }))
    const fake = installFakeFetch({ login: 'alice' })
    try {
      expect(
        await main(['start', '--fake', '--config', writeConfig(dir, { policy: { allowed: ['alice'] } })], c.io),
      ).toBe(2)
      expect(c.err.join('')).toContain('Startup refused (agent-allowed): ')
      expect(c.err.join('')).not.toMatch(/rule \d/)
    } finally {
      fake.restore()
    }
  }, 30_000)

  it('a consented subscription starts, records the consent without the token value, and warns on stderr', async () => {
    const dir = tempDir()
    const path = writeConfig(dir, {
      policy: { allowed: ['owner', 'mate'] },
      auth: { mode: 'subscription', acceptSubscriptionSharedUseRisk: true },
    })
    const c = cliIo(dir, cliEnv(dir, { CLAUDE_CODE_OAUTH_TOKEN: 't-oauth-value' }))
    const p = main(['start', '--fake', '--config', path], c.io)
    await waitUntil(() => c.out.join('').includes('"runtime.started"'), 10_000)
    c.listeners.SIGINT!()
    expect(await p).toBe(0)
    expect(c.out.join('')).toContain('"auth.consent"')
    expect(c.out.join('')).toContain('"allowedHash"')
    expect(c.err.join('')).toContain('warning: ToS risk')
    expect(c.out.join('') + c.err.join('')).not.toContain('t-oauth-value')
  }, 30_000)

  it('the api-key value never reaches stdout or stderr', async () => {
    const dir = tempDir()
    const c = cliIo(dir, cliEnv(dir))
    const p = main(['start', '--fake', '--config', writeConfig(dir)], c.io)
    await waitUntil(() => c.out.join('').includes('"runtime.started"'), 10_000)
    c.listeners.SIGINT!()
    expect(await p).toBe(0)
    expect(c.out.join('') + c.err.join('')).not.toContain('test-key')
  }, 30_000)
})
