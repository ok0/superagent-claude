/**
 * The adapter env carries only the inherited whitelist and the selected auth mode's variables.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { runtimeEnv, type Credential } from './credentials.ts'
import type { AgentRuntime } from '../executor/contract.ts'
import type { LogRecord, LogSink } from '../sources/host.ts'
import { workerKey } from '../executor/worker-executor.ts'
import { ClaudeRuntime, type QueryFn, type ToolDenial } from '../runtimes/claude/runtime.ts'
import { CLAUDE_INHERITED_ENV } from '../runtimes/claude/options.ts'
import { FakeRuntime, type FakeScript } from '../runtimes/fake/runtime.ts'

export function agentEnv(
  credential: Credential,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
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
  log?: LogSink
}

export function toolDeniedRecord(d: ToolDenial, at: string): LogRecord {
  return {
    level: 'warn',
    at,
    event: 'worker.tool_denied',
    ...(d.key.startsWith(workerKey('')) ? { ticketId: d.key.slice(workerKey('').length) } : {}),
    session: d.key,
    tool: d.tool,
    reason: d.reason,
    ...(d.agentId !== undefined ? { agentId: d.agentId } : {}),
  }
}

export interface Agent {
  runtime: AgentRuntime
  workspaces: 'git' | 'scratch'
  router: 'session' | 'deterministic'
}

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
      weakerNestedSandbox: o.config.security.weakerNestedSandbox,
      allowUnsandboxed: o.config.security.allowUnsandboxed,
      children: join(o.config.stateDir, 'children.json'),
      ...(o.query ? { query: o.query } : {}),
      ...(o.stderr ? { stderr: o.stderr } : {}),
      onDeny: d => o.log?.(toolDeniedRecord(d, new Date().toISOString())),
    }),
    workspaces: 'git',
    router: 'session',
  }
}
