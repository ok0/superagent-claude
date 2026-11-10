import type { AuthMode } from './types.ts'

export type AuthVarName = 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN'

export type AuthResolution =
  | { kind: 'ok'; mode: AuthMode; varName: AuthVarName }
  | { kind: 'missing'; problems: string[] }
  | { kind: 'refused'; problems: string[] };

const API_VAR: AuthVarName = 'ANTHROPIC_API_KEY'
const TOKEN_VAR: AuthVarName = 'CLAUDE_CODE_OAUTH_TOKEN'

function present(env: Record<string, string | undefined>, name: string): boolean {
  const value = env[name]
  return value !== undefined && value !== ''
}

export function resolveAuth(env: Record<string, string | undefined>): AuthResolution {
  const explicit = present(env, 'SPIKE_AUTH_MODE') ? env['SPIKE_AUTH_MODE'] : undefined
  if (explicit !== undefined && explicit !== 'api-key' && explicit !== 'subscription') {
    return { kind: 'refused', problems: ['SPIKE_AUTH_MODE must be api-key or subscription'] }
  }
  const hasApi = present(env, API_VAR)
  const hasToken = present(env, TOKEN_VAR)
  if (explicit === undefined && hasApi && hasToken) {
    return {
      kind: 'refused',
      problems: ['both credentials present; set SPIKE_AUTH_MODE=api-key|subscription'],
    }
  }

  const problems: string[] = []
  if (env['SUPERAGENT_CLAUDE_LIVE'] !== '1') {
    problems.push('SUPERAGENT_CLAUDE_LIVE=1 is not set')
  }

  let mode: AuthMode | undefined
  if (explicit === 'api-key' || explicit === 'subscription') {
    mode = explicit
  } else if (hasApi) {
    mode = 'api-key'
  } else if (hasToken) {
    mode = 'subscription'
  }

  if (mode === undefined) {
    problems.push(
      'no credential: set ANTHROPIC_API_KEY (api-key, recommended) or CLAUDE_CODE_OAUTH_TOKEN (subscription, issue with `claude setup-token`)',
    )
    return { kind: 'missing', problems }
  }

  const varName: AuthVarName = mode === 'api-key' ? API_VAR : TOKEN_VAR
  if (!present(env, varName)) {
    problems.push(`SPIKE_AUTH_MODE=${mode} but ${varName} is not set`)
  }

  if (problems.length > 0) {
    return { kind: 'missing', problems }
  }
  return { kind: 'ok', mode, varName }
}

export function buildSdkEnv(
  auth: { mode: AuthMode; varName: AuthVarName },
  source: Record<string, string | undefined>,
  dirs: { configDir: string; homeDir: string; tmpDir: string },
): Record<string, string> {
  const env: Record<string, string> = { PATH: source['PATH'] ?? '' }
  for (const key of ['LANG', 'USER', 'LOGNAME', 'SHELL']) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  env['HOME'] = dirs.homeDir
  env['TMPDIR'] = dirs.tmpDir
  env['CLAUDE_CONFIG_DIR'] = dirs.configDir
  env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'] = '1'
  env[auth.varName] = source[auth.varName] ?? ''
  return env
}

export const SUPPLY_HINT = [
  'Supply the credential only through the shell environment, for example:',
  '  read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY',
  '  SUPERAGENT_CLAUDE_LIVE=1 pnpm spike:sdk',
  'Subscription mode needs CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.',
  'The existing claude login (keychain or the user config dir) is deliberately not used.',
  'SPIKE_AUTH_MODE selects the mode when both variables are set.',
].join('\n')
