/** The assembly point's repository access: remote URL without credentials, token only in the clone and fetch env. */
import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/app/config.ts'
import { installedSources, repositoryAccess } from '../src/app/sources.ts'
import { Commands } from '../src/infra/commands.ts'

describe('repository access', () => {
  it('authenticates clone and fetch through env-scoped config and never puts the token in the remote', () => {
    const a = repositoryAccess({ SUPERAGENT_CLAUDE_GITHUB_TOKEN: ' tok123 ' })
    const encoded = Buffer.from('x-access-token:tok123').toString('base64')
    expect(a.remote('o/r')).toBe('https://github.com/o/r.git')
    expect(a.env('o/r')).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + encoded })
    expect(a.secrets).toContain('tok123')
    expect(a.secrets).toContain(encoded)
  })

  it('tries unauthenticated without a token', () => {
    const a = repositoryAccess({})
    expect(a.env('o/r')).toEqual({})
    expect(a.secrets).toEqual([])
  })

  it('installedSources provides the repository access', () => {
    const sources = installedSources(ConfigSchema.parse({ repositories: ['o/r'], policy: { allowed: ['alice'] } }), { SUPERAGENT_CLAUDE_GITHUB_TOKEN: 't' }, { commands: new Commands({ apiProgram: 'gh', baseEnv: {} }) })
    expect(sources.access.remote('o/r')).toBe('https://github.com/o/r.git')
  })
})
