/**
 * The agent runtime, workspace choice and Router mode for `start`: the Claude runtime with git worktrees and a Router session, or the scripted fake runtime with scratch directories and the deterministic assessor; the adapter env carries only the inherited whitelist and the selected auth mode's variables.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { runtimeEnv, type Credential } from './credentials.ts'
import type { AgentRuntime } from '../executor/contract.ts'
import { ClaudeRuntime, type QueryFn } from '../runtimes/claude/runtime.ts'
import { CLAUDE_INHERITED_ENV } from '../runtimes/claude/options.ts'
import { FakeRuntime, type FakeScript } from '../runtimes/fake/runtime.ts'

export function agentEnv(credential: Credential, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const values: Record<string, string> = {}
  for (const name of CLAUDE_INHERITED_ENV) {
    const value = env[name]
    if (typeof value === 'string') values[name] = value
  }
  return { ...values, ...runtimeEnv(credential) }
}

export interface AgentOptions {
  config: Config
  credential: Credential
  env: Readonly<Record<string, string | undefined>>
  fake?: FakeScript
  query?: QueryFn
  stderr?: (text: string) => void
}

export interface Agent { runtime: AgentRuntime; workspaces: 'git' | 'scratch'; router: 'session' | 'deterministic' }

export function createAgent(o: AgentOptions): Agent {
  if (o.fake) return { runtime: new FakeRuntime(o.fake), workspaces: 'scratch', router: 'deterministic' }
  const configDir = join(o.config.stateDir, 'claude')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  return {
    runtime: new ClaudeRuntime({
      mode: o.config.auth.mode,
      configDir,
      env: agentEnv(o.credential, o.env),
      trustRepoConfig: o.config.security.trustRepoConfig,
      ...(o.query ? { query: o.query } : {}),
      ...(o.stderr ? { stderr: o.stderr } : {}),
    }),
    workspaces: 'git',
    router: 'session',
  }
}
