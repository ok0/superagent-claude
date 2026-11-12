/** The policy part maps onto the policy Settings (`paused` and `eval` keep their defaults; they are not file keys). */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { AUTH_ENV, type AuthMode } from '../runtimes/claude/options.ts'
import { LIMITS } from '../policy/limits.ts'
import { LoginSchema, PolicyConfigSchema, SettingsSchema, type Settings } from '../policy/policy.ts'

export const CONFIG_FILE = 'superagent-claude.json'
export const DEFAULT_STATE_DIR = '~/.superagent-claude'

export const RepositorySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be owner/name')

const BRANCH_NAME = /^(?![-/])(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/

export const BranchNameSchema = z
  .string()
  .regex(
    BRANCH_NAME,
    'must be a branch name: letters, digits and . _ - /, not starting with - or /, without .. or //, not ending with / or .lock',
  )

const RepositoryEntrySchema = z.union([
  RepositorySchema,
  z
    .object({
      repository: RepositorySchema,
      branchFrom: BranchNameSchema.optional(),
      pullRequestTo: BranchNameSchema.optional(),
    })
    .strict(),
])

const AUTH_MODES = Object.keys(AUTH_ENV) as [AuthMode, ...AuthMode[]]

export type StartupRule =
  | 'config'
  | 'credential'
  | 'allowed-empty'
  | 'repositories-empty'
  | 'agent-allowed'
  | 'subscription-shared'
  | 'unsandboxed'
  | 'no-repository'
  | 'agent-token'
  | 'agent-account'

/** A refused start (exit code 2); `rule` names the violated startup rule. */
export class StartupRefused extends Error {
  readonly rule: StartupRule
  constructor(rule: StartupRule, message: string) {
    super(message)
    this.name = 'StartupRefused'
    this.rule = rule
  }
}

export const ConfigSchema = z
  .object({
    repositories: z
      .array(RepositoryEntrySchema)
      .min(1, 'must name at least one repository')
      .superRefine((items, ctx) => {
        const seen = new Set<string>()
        const reported = new Set<string>()
        for (const item of items) {
          const name = typeof item === 'string' ? item : item.repository
          const key = name.toLowerCase()
          if (seen.has(key)) {
            if (!reported.has(key)) {
              reported.add(key)
              ctx.addIssue({ code: 'custom', message: `lists ${name} more than once` })
            }
          } else seen.add(key)
        }
      })
      .transform(items => items.map(item => (typeof item === 'string' ? item : item.repository))),
    policy: z
      .object({
        allowed: z.array(LoginSchema).min(1, 'must name at least one login'),
        acceptMode: z.enum(['off', 'observe', 'auto']).default('observe'),
        rules: PolicyConfigSchema.shape.rules,
        admission: PolicyConfigSchema.shape.admission,
      })
      .strict(),
    auth: z
      .object({
        mode: z.enum(AUTH_MODES).default('api-key'),
        owner: LoginSchema.optional(),
        acceptSubscriptionSharedUseRisk: z.boolean().default(false),
      })
      .strict()
      .default({ mode: 'api-key', acceptSubscriptionSharedUseRisk: false }),
    delivery: z
      .object({ allowAutoMerge: z.boolean().default(false) })
      .strict()
      .default({ allowAutoMerge: false }),
    workers: z
      .object({
        max: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(2),
        maxTurns: z.number().int().min(1).default(100),
        maxBudgetUsd: z.number().positive().default(5),
      })
      .strict()
      .default({ max: 2, maxTurns: 100, maxBudgetUsd: 5 }),
    network: z
      .object({
        allow: z.array(z.string().trim().min(1).max(253)).default([]),
      })
      .strict()
      .default({ allow: [] }),
    security: z
      .object({
        trustRepoConfig: z.boolean().default(false),
        allowUnsandboxed: z.boolean().default(false),
        weakerNestedSandbox: z.boolean().default(false),
      })
      .strict()
      .default({ trustRepoConfig: false, allowUnsandboxed: false, weakerNestedSandbox: false }),
    retention: z
      .object({
        endedTicketDays: z.number().int().min(1).default(14),
      })
      .strict()
      .default({ endedTicketDays: 14 }),
    models: z
      .object({
        router: z.string().trim().min(1).optional(),
        worker: z.string().trim().min(1).optional(),
      })
      .strict()
      .default({}),
    review: z
      .object({
        enabled: z.boolean().default(true),
        minChangedLines: z.number().int().min(1).default(50),
        maxPerTicket: z.number().int().min(1).default(3),
      })
      .strict()
      .default({ enabled: true, minChangedLines: 50, maxPerTicket: 3 }),
    stateDir: z.string().trim().min(1).default(DEFAULT_STATE_DIR),
  })
  .strict()

export type Config = z.infer<typeof ConfigSchema> & {
  branches?: Readonly<Record<string, { branchFrom?: string; pullRequestTo?: string }>>
}

export function repositoryBranches(entries: unknown): Record<string, { branchFrom?: string; pullRequestTo?: string }> {
  const parsed = z.array(RepositoryEntrySchema).safeParse(entries)
  if (!parsed.success) return {}
  const branches: Record<string, { branchFrom?: string; pullRequestTo?: string }> = {}
  for (const entry of parsed.data) {
    if (typeof entry === 'string') continue
    const { repository, branchFrom, pullRequestTo } = entry
    if (branchFrom === undefined && pullRequestTo === undefined) continue
    branches[repository.toLowerCase()] = {
      ...(branchFrom !== undefined ? { branchFrom } : {}),
      ...(pullRequestTo !== undefined ? { pullRequestTo } : {}),
    }
  }
  return branches
}

export function branchesOf(
  config: Pick<Config, 'branches'>,
  repository: string,
): { branchFrom?: string; pullRequestTo?: string } {
  return config.branches?.[repository.toLowerCase()] ?? {}
}

export class ConfigError extends StartupRefused {
  constructor(message: string) {
    super('config', message)
    this.name = 'ConfigError'
  }
}

export function expandStateDir(
  stateDir: string,
  base: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (stateDir === '~' || stateDir.startsWith('~/')) return join(env.HOME || homedir(), stateDir.slice(2))
  if (isAbsolute(stateDir)) return stateDir
  return resolve(base, stateDir)
}

export function loadConfig(path: string, env: Readonly<Record<string, string | undefined>> = process.env): Config {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      throw new ConfigError('Config file not found: ' + path)
    throw new ConfigError(
      `Cannot read the config file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(
      `The config file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const result = ConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(
      `The config file ${path} is invalid:\n` +
        result.error.issues.map(issue => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n'),
    )
  }
  const data = result.data
  const branches = repositoryBranches((raw as { repositories?: unknown }).repositories)
  return {
    ...data,
    stateDir: expandStateDir(data.stateDir, dirname(path), env),
    ...(Object.keys(branches).length ? { branches } : {}),
  }
}

const byLogin = (a: string, b: string): number => {
  const x = a.toLowerCase(),
    y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0
}

/**
 * Maps the config policy onto Settings. The allowed list is sorted here so that its order does not change
 * the policy version. The case of each login is kept; comparison is case-insensitive.
 */
export function settingsOf(config: Config): Settings {
  const { allowed, acceptMode, rules, admission } = config.policy
  return SettingsSchema.parse({ policy: { allowed: [...allowed].sort(byLogin), acceptMode, rules, admission } })
}
