/**
 * The config file `superagent-claude.json`: this build reads `repositories`, `policy.allowed`, `policy.acceptMode`, `workers` and `stateDir`, and maps the policy part onto the policy Settings (`paused` and `eval` keep their defaults; they are not file keys).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { LIMITS } from '../policy/limits.ts'
import { LoginSchema, SettingsSchema, type Settings } from '../policy/policy.ts'

export const CONFIG_FILE = 'superagent-claude.json'
export const DEFAULT_STATE_DIR = '~/.superagent-claude'

export const RepositorySchema = z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be owner/name')

export const ConfigSchema = z.object({
  repositories: z.array(RepositorySchema).min(1, 'must name at least one repository'),
  policy: z.object({
    allowed: z.array(LoginSchema).min(1, 'must name at least one login'),
    acceptMode: z.enum(['off', 'observe', 'auto']).default('observe'),
  }).strict(),
  workers: z.object({
    max: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(2),
    maxTurns: z.number().int().min(1).default(100),
    maxBudgetUsd: z.number().positive().default(5),
  }).strict().default({ max: 2, maxTurns: 100, maxBudgetUsd: 5 }),
  stateDir: z.string().trim().min(1).default(DEFAULT_STATE_DIR),
}).strict()

export type Config = z.infer<typeof ConfigSchema>

export class ConfigError extends Error {}

export function expandStateDir(stateDir: string, base: string, env: Readonly<Record<string, string | undefined>>): string {
  if (stateDir === '~' || stateDir.startsWith('~/')) return join(env.HOME || homedir(), stateDir.slice(2))
  if (isAbsolute(stateDir)) return stateDir
  return resolve(base, stateDir)
}

export function loadConfig(path: string, env: Readonly<Record<string, string | undefined>> = process.env): Config {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new ConfigError('Config file not found: ' + path)
    throw new ConfigError(`Cannot read the config file ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`The config file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = ConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(`The config file ${path} is invalid:\n` + result.error.issues.map(issue => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n'))
  }
  const data = result.data
  return { ...data, stateDir: expandStateDir(data.stateDir, dirname(path), env) }
}

export function settingsOf(config: Config): Settings {
  return SettingsSchema.parse({ policy: { allowed: config.policy.allowed, acceptMode: config.policy.acceptMode } })
}
