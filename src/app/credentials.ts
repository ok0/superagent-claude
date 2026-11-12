/**
 * Resolves the selected auth mode into the environment the runtime may receive.
 * Names are reported, values never.
 */
import { createHash } from 'node:crypto'
import { AUTH_ENV, type AuthMode } from '../runtimes/claude/options.ts'
import type { RuntimeProbe } from '../executor/contract.ts'
import { sameName } from '../policy/actors.ts'
import { StartupRefused, type Config, type StartupRule } from './config.ts'

export interface Credential {
  readonly mode: AuthMode
  readonly env: Readonly<Record<string, string>>
  toJSON(): { mode: AuthMode }
}
export interface StartupReport {
  warnings: string[]
  consent?: { at: string; allowedHash: string }
}

/**
 * Per mode, the requirements. A requirement is met when every variable of one of its alternatives is set (non-blank).
 * All names are in AUTH_ENV[mode].
 */
export const REQUIRED_ENV: Record<AuthMode, readonly (readonly (readonly string[])[])[]> = {
  'api-key': [[['ANTHROPIC_API_KEY']]],
  subscription: [[['CLAUDE_CODE_OAUTH_TOKEN']]],
  bedrock: [[['AWS_REGION']], [['AWS_PROFILE'], ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']]],
  vertex: [[['CLOUD_ML_REGION']], [['ANTHROPIC_VERTEX_PROJECT_ID']]],
}

export const SUBSCRIPTION_POLICY_WARNING =
  'auth.mode subscription runs the agent on a personal Claude subscription: automated use is a gray area of the subscription terms, and this setup assumes personal use by the subscriber.'
export const SHARED_USE_WARNING =
  "ToS risk: with auth.mode subscription, people other than the subscription owner (policy.allowed is not exactly [auth.owner]) can make the agent work on the owner's subscription; this shared use may violate the subscription terms."
export const SANDBOX_DOC = 'docs/deploy.md#sandbox-in-containers'
export const UNSANDBOXED_WARNING = `security.allowUnsandboxed is true and the runtime sandbox is unavailable here: sessions run without the sandbox, network.allow is not enforced and commands can read the agent's tokens from other processes; restrict egress outside the agent (see ${SANDBOX_DOC})`

export const RULE_NUMBER: Partial<Record<StartupRule, number>> = {
  credential: 1,
  'allowed-empty': 2,
  'repositories-empty': 3,
  'agent-allowed': 4,
  'subscription-shared': 6,
  unsandboxed: 7,
  'no-repository': 8,
}

export function refused(rule: StartupRule, text: string): StartupRefused {
  const number = RULE_NUMBER[rule]
  return new StartupRefused(
    rule,
    number ? `Startup refused (rule ${number}, ${rule}): ${text}` : `Startup refused (${rule}): ${text}`,
  )
}

const present = (value: string | undefined): value is string => typeof value === 'string' && value.trim() !== ''

export function resolveCredential(mode: AuthMode, env: Readonly<Record<string, string | undefined>>): Credential {
  const missing = REQUIRED_ENV[mode]
    .filter(requirement => !requirement.some(alternative => alternative.every(name => present(env[name]))))
    .map(requirement => requirement.map(alternative => alternative.join('+')).join(' or '))
  if (missing.length) throw refused('credential', `auth.mode ${mode} needs ${missing.join(', ')} in the environment`)
  const values: Record<string, string> = {}
  for (const name of AUTH_ENV[mode]) {
    const value = env[name]
    if (present(value)) values[name] = value
  }
  if (mode === 'bedrock') values.CLAUDE_CODE_USE_BEDROCK = '1'
  if (mode === 'vertex') values.CLAUDE_CODE_USE_VERTEX = '1'
  return Object.freeze({ mode, env: Object.freeze(values), toJSON: () => ({ mode }) })
}

export function runtimeEnv(credential: Credential): Record<string, string> {
  return { ...credential.env }
}

export function allowedHash(allowed: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...new Set(allowed.map(login => login.toLowerCase()))].sort()))
    .digest('hex')
    .slice(0, 16)
}

export function ownerOnly(config: Config): boolean {
  const owner = config.auth.owner
  if (owner === undefined) return false
  const allowed = new Set(config.policy.allowed.map(login => login.toLowerCase()))
  return allowed.size === 1 && allowed.has(owner.toLowerCase())
}

export function assertAgentLogin(config: Config, login: string): void {
  if (config.policy.allowed.some(entry => sameName(entry, login))) {
    throw refused(
      'agent-allowed',
      `the agent account @${login} is on policy.allowed; remove it so the agent never admits its own comments`,
    )
  }
}

export function assertRepositoryAccess(config: Config, accessible: readonly string[]): void {
  if (accessible.length === 0) {
    throw refused(
      'no-repository',
      `none of the ${config.repositories.length} configured repositories is accessible with the agent token`,
    )
  }
}

export function assertStartupPolicy(
  config: Config,
  credential: Pick<Credential, 'mode'>,
  agentLogin?: string,
  probe?: RuntimeProbe,
  now: () => number = Date.now,
): StartupReport {
  if (credential.mode !== config.auth.mode) throw refused('credential', 'the credential does not match auth.mode')
  if (config.policy.allowed.length === 0) throw refused('allowed-empty', 'policy.allowed is empty')
  if (config.repositories.length === 0) throw refused('repositories-empty', 'repositories is empty')
  if (agentLogin !== undefined) assertAgentLogin(config, agentLogin)
  const warnings: string[] = []
  const subscription = config.auth.mode === 'subscription'
  let consent: StartupReport['consent']
  if (subscription) warnings.push(SUBSCRIPTION_POLICY_WARNING)
  if (subscription && !ownerOnly(config)) {
    warnings.push(SHARED_USE_WARNING)
    if (config.auth.acceptSubscriptionSharedUseRisk !== true) {
      throw refused(
        'subscription-shared',
        SHARED_USE_WARNING +
          ' Set auth.acceptSubscriptionSharedUseRisk to true to accept this risk, or set policy.allowed to [auth.owner].',
      )
    }
    consent = { at: new Date(now()).toISOString(), allowedHash: allowedHash(config.policy.allowed) }
  }
  if (probe && config.policy.acceptMode === 'auto' && probe.sandbox === false && !config.security.allowUnsandboxed) {
    throw refused(
      'unsandboxed',
      `policy.acceptMode auto needs the runtime sandbox, which is unavailable here; set security.allowUnsandboxed to true to run without it; see ${SANDBOX_DOC}`,
    )
  }
  if (probe && probe.sandbox === false && config.security.allowUnsandboxed) warnings.push(UNSANDBOXED_WARNING)
  return { warnings, ...(consent ? { consent } : {}) }
}
