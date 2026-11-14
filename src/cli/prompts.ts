/**
 * `issuecrew prompts diff`: reports built-in default changes of the team sections from the database opened
 * read-only; it takes no lock and needs no running daemon.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CONFIG_FILE, ConfigError, loadConfig } from '../app/config.ts'
import { formatDiff, loadBuiltins, promptDiff, promptRows, readTeam, type PromptRow } from '../app/prompts.ts'
import { databasePath } from '../app/store.ts'
import { openReadOnly } from '../app/store-read.ts'
import type { CliIo } from './main.ts'

export const PROMPTS_USAGE = 'Usage: issuecrew prompts diff [--config <path>]\n'

export function promptsCommand(argv: readonly string[], io: Pick<CliIo, 'out' | 'err' | 'cwd' | 'env'>): number {
  if (argv[0] !== 'diff') {
    io.err(`issuecrew: unknown prompts command '${argv[0] ?? ''}'\n` + PROMPTS_USAGE)
    return 2
  }
  let configArg: string | undefined
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--config') {
      const value = argv[i + 1]
      if (value === undefined) {
        io.err(`issuecrew: option '--config' needs a path\n` + PROMPTS_USAGE)
        return 2
      }
      configArg = value
      i++
    } else {
      io.err(`issuecrew: unknown option '${arg}'\n` + PROMPTS_USAGE)
      return 2
    }
  }

  const path = resolve(io.cwd, configArg ?? CONFIG_FILE)
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig(path, io.env)
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(`issuecrew: ${error.message}\n`)
      return 2
    }
    throw error
  }

  const db = databasePath(config.stateDir)
  let rows: PromptRow[] = []
  if (existsSync(db)) {
    const reader = openReadOnly(db)
    try {
      rows = promptRows(reader.db)
    } finally {
      reader.close()
    }
  }
  io.out(formatDiff(promptDiff(loadBuiltins(), readTeam(join(dirname(path), 'prompts', 'team')), rows)))
  return 0
}
