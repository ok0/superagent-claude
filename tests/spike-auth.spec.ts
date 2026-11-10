import { describe, expect, it } from 'vitest'
import { buildSdkEnv, resolveAuth } from '../spikes/sdk/lib/auth.ts'

const K = 'sk-' + 'ant-' + 'test-AAAAAAAAAAAA'
const T = 'sk-' + 'ant-' + 'oat01-test-BBBBBBBB'
const LIVE = { SUPERAGENT_CLAUDE_LIVE: '1' }

describe('resolveAuth', () => {
  it('accepts an API key alone when live is enabled', () => {
    expect(resolveAuth({ ...LIVE, ANTHROPIC_API_KEY: K })).toEqual({
      kind: 'ok',
      mode: 'api-key',
      varName: 'ANTHROPIC_API_KEY',
    })
  })

  it('accepts a subscription token alone when live is enabled', () => {
    expect(resolveAuth({ ...LIVE, CLAUDE_CODE_OAUTH_TOKEN: T })).toMatchObject({
      kind: 'ok',
      mode: 'subscription',
    })
  })

  it('refuses both credentials without an explicit mode', () => {
    expect(resolveAuth({ ...LIVE, ANTHROPIC_API_KEY: K, CLAUDE_CODE_OAUTH_TOKEN: T }).kind).toBe('refused')
  })

  it('selects subscription when both are present and the mode is explicit', () => {
    expect(
      resolveAuth({
        ...LIVE,
        SPIKE_AUTH_MODE: 'subscription',
        ANTHROPIC_API_KEY: K,
        CLAUDE_CODE_OAUTH_TOKEN: T,
      }),
    ).toEqual({ kind: 'ok', mode: 'subscription', varName: 'CLAUDE_CODE_OAUTH_TOKEN' })
  })

  it('refuses an invalid SPIKE_AUTH_MODE', () => {
    expect(resolveAuth({ ...LIVE, SPIKE_AUTH_MODE: 'bogus' }).kind).toBe('refused')
  })

  it('reports missing when no credential is set', () => {
    const result = resolveAuth({ ...LIVE })
    expect(result.kind).toBe('missing')
    const text = result.kind === 'ok' ? '' : result.problems.join('\n')
    expect(text).toContain('ANTHROPIC_API_KEY')
    expect(text).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(text).toContain('claude setup-token')
  })

  it('reports missing when live is not enabled', () => {
    const result = resolveAuth({ ANTHROPIC_API_KEY: K })
    expect(result.kind).toBe('missing')
    const text = result.kind === 'ok' ? '' : result.problems.join('\n')
    expect(text).toContain('SUPERAGENT_CLAUDE_LIVE=1')
  })

  it('reports missing when the explicit mode lacks its variable', () => {
    expect(resolveAuth({ ...LIVE, SPIKE_AUTH_MODE: 'api-key', CLAUDE_CODE_OAUTH_TOKEN: T }).kind).toBe('missing')
  })
})

describe('buildSdkEnv', () => {
  it('passes only the allowed keys and the selected credential', () => {
    const env = buildSdkEnv(
      { mode: 'api-key', varName: 'ANTHROPIC_API_KEY' },
      {
        PATH: '/usr/bin',
        HOME: '/real',
        ANTHROPIC_API_KEY: K,
        CLAUDE_CODE_OAUTH_TOKEN: T,
        GH_TOKEN: 'x',
        AWS_SECRET_ACCESS_KEY: 'y',
        LANG: 'C',
      },
      { configDir: '/tmp/x/claude-config', homeDir: '/tmp/x/home', tmpDir: '/tmp/x' },
    )
    expect(Object.keys(env).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      'CLAUDE_CONFIG_DIR',
      'HOME',
      'LANG',
      'PATH',
      'TMPDIR',
    ])
    expect(env['HOME']).toBe('/tmp/x/home')
    expect(Object.values(env)).not.toContain(T)
  })
})
