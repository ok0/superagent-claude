import { vi } from 'vitest'
import { LIVE_TARGET_ENV, type LiveTarget } from '../live/target.ts'

export const EXAMPLE_TARGET_ENV = {
  SUPERAGENT_CLAUDE_LIVE_REPO: 'example/playground',
  SUPERAGENT_CLAUDE_LIVE_REPORT_REPO: 'example/main',
  SUPERAGENT_CLAUDE_LIVE_OWNER_LOGIN: 'example-owner',
  SUPERAGENT_CLAUDE_LIVE_AGENT_LOGIN: 'example-agent',
} as const

export const EXAMPLE_TARGET: LiveTarget = {
  repo: 'example/playground',
  owner: 'example',
  name: 'playground',
  ownerLogin: 'example-owner',
  agentLogin: 'example-agent',
  reportRepo: 'example/main',
}

const TARGET_NAMES = [
  LIVE_TARGET_ENV.repo,
  LIVE_TARGET_ENV.reportRepo,
  LIVE_TARGET_ENV.ownerLogin,
  LIVE_TARGET_ENV.agentLogin,
] as const

export function stubLiveTarget(values: Readonly<Record<string, string | undefined>> = EXAMPLE_TARGET_ENV): void {
  for (const name of TARGET_NAMES) vi.stubEnv(name, undefined)
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value)
}

export function clearLiveTarget(): void {
  for (const name of TARGET_NAMES) vi.stubEnv(name, undefined)
}
