/** Credential resolution per auth mode: only the selected mode's variables reach the runtime, refusals carry names only. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { AUTH_ENV, type AuthMode } from '../src/runtimes/claude/options.ts'
import { REQUIRED_ENV, resolveCredential, runtimeEnv } from '../src/app/credentials.ts'
import { StartupRefused } from '../src/app/config.ts'

const MODES: AuthMode[] = ['api-key', 'subscription', 'bedrock', 'vertex']
const FULL_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: 'k-api',
  CLAUDE_CODE_OAUTH_TOKEN: 'k-sub',
  AWS_REGION: 'r',
  AWS_PROFILE: 'p',
  AWS_ACCESS_KEY_ID: 'k-aws',
  AWS_SECRET_ACCESS_KEY: 'k-aws-s',
  CLOUD_ML_REGION: 'r2',
  ANTHROPIC_VERTEX_PROJECT_ID: 'proj',
  GOOGLE_APPLICATION_CREDENTIALS: '/adc.json',
  SUPERAGENT_CLAUDE_GITHUB_TOKEN: 'k-gh',
  GH_TOKEN: 'k-gh2',
  DAEMON_SECRET: 'k-d',
  PATH: '/bin',
}

function refusal(action: () => unknown): StartupRefused {
  try {
    action()
  } catch (error) {
    if (error instanceof StartupRefused) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('credentials', () => {
  it.each(MODES)('runtimeEnv carries only the %s variables', mode => {
    const env = runtimeEnv(resolveCredential(mode, FULL_ENV))
    const others = MODES.filter(other => other !== mode).flatMap(other => AUTH_ENV[other])
    for (const key of Object.keys(env)) expect(AUTH_ENV[mode]).toContain(key)
    for (const key of [...others, 'SUPERAGENT_CLAUDE_GITHUB_TOKEN', 'GH_TOKEN', 'DAEMON_SECRET', 'PATH'])
      expect(env).not.toHaveProperty(key)
    if (mode === 'bedrock') expect(env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'r' })
    if (mode === 'vertex')
      expect(env).toMatchObject({
        CLAUDE_CODE_USE_VERTEX: '1',
        CLOUD_ML_REGION: 'r2',
        ANTHROPIC_VERTEX_PROJECT_ID: 'proj',
      })
  })

  it('refuses a missing variable with its name only', () => {
    const cases: [AuthMode, Record<string, string>, string[]][] = [
      ['api-key', {}, ['ANTHROPIC_API_KEY']],
      ['subscription', {}, ['CLAUDE_CODE_OAUTH_TOKEN']],
      ['bedrock', { AWS_PROFILE: 'zz-profile-value' }, ['AWS_REGION']],
      ['bedrock', { AWS_ACCESS_KEY_ID: 'zz-key-value' }, ['AWS_REGION']],
      ['vertex', {}, ['CLOUD_ML_REGION']],
    ]
    for (const [mode, env, names] of cases) {
      const error = refusal(() => resolveCredential(mode, env))
      expect(error.rule).toBe('credential')
      for (const name of names) expect(error.message).toContain(name)
      for (const value of Object.values(env)) expect(error.message).not.toContain(value)
    }
  })

  it('blank values count as missing', () => {
    const error = refusal(() => resolveCredential('api-key', { ANTHROPIC_API_KEY: '  ' }))
    expect(error.rule).toBe('credential')
  })

  it('REQUIRED_ENV names are AUTH_ENV names', () => {
    for (const mode of MODES) {
      for (const requirement of REQUIRED_ENV[mode]) {
        for (const alternative of requirement) {
          for (const name of alternative) expect(AUTH_ENV[mode]).toContain(name)
        }
      }
    }
  })

  it('AuthMode and AUTH_ENV come from the runtime options', () => {
    for (const file of ['../src/app/credentials.ts', '../src/app/config.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(text).toContain("from '../runtimes/claude/options.ts'")
      for (const line of text.split('\n').filter(item => !item.startsWith('import'))) {
        expect(line).not.toMatch(/type\s+AuthMode\s*=/)
        expect(line).not.toMatch(/AUTH_ENV\s*[:=]/)
      }
    }
    expect(Object.keys(REQUIRED_ENV).sort()).toEqual(Object.keys(AUTH_ENV).sort())
  })

  it('JSON.stringify of a credential carries only the mode', () => {
    expect(JSON.stringify(resolveCredential('api-key', FULL_ENV))).toBe('{"mode":"api-key"}')
  })
})
