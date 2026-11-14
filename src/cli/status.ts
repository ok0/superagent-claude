/**
 * issuecrew status and needs: read the state database opened read-only (no lock, no HTTP server), so they
 * answer while the daemon runs.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { CONFIG_FILE, loadConfig, StartupRefused, type Config } from '../app/config.ts'
import { formatNeeds, formatStatus, needsView, redact, statusView } from '../app/status.ts'
import { databasePath } from '../app/store.ts'
import { openReadOnly, writerActive, type StoreReader } from '../app/store-read.ts'
import type { CliIo } from './main.ts'

export const EXIT_NO_STATE = 3
export const STATUS_USAGE = 'Usage: issuecrew status [--config <path>]\n'
export const NEEDS_USAGE = 'Usage: issuecrew needs [--all] [--config <path>]\n'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function readState(
  argv: readonly string[],
  io: Pick<CliIo, 'out' | 'err' | 'cwd' | 'env'>,
  usage: string,
  allowAll: boolean,
  render: (reader: StoreReader, config: Config, db: string, all: boolean) => string,
): number {
  let configArg: string | undefined
  let all = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--config') {
      const value = argv[i + 1]
      if (value === undefined) {
        io.err(`issuecrew: option '--config' needs a path\n` + usage)
        return 2
      }
      configArg = value
      i++
    } else if (arg === '--all' && allowAll) {
      all = true
    } else {
      io.err(`issuecrew: unknown option '${arg}'\n` + usage)
      return 2
    }
  }

  const path = resolve(io.cwd, configArg ?? CONFIG_FILE)
  let config: Config
  try {
    config = loadConfig(path, io.env)
  } catch (error) {
    if (error instanceof StartupRefused) {
      io.err(`issuecrew: ${error.message}\n`)
      return 2
    }
    throw error
  }

  const db = databasePath(config.stateDir)
  if (!existsSync(db)) {
    io.err(`issuecrew: no state database at ${db}; issuecrew has not started with this config\n`)
    return EXIT_NO_STATE
  }

  let reader: StoreReader
  try {
    reader = openReadOnly(db)
  } catch (error) {
    io.err(`issuecrew: cannot read the state database ${db}: ${firstLine(messageOf(error))}\n`)
    return EXIT_NO_STATE
  }
  let text: string
  try {
    text = render(reader, config, db, all)
  } catch (error) {
    io.err(`issuecrew: cannot read the state database ${db}: ${firstLine(messageOf(error))}\n`)
    return EXIT_NO_STATE
  } finally {
    reader.close()
  }
  io.out(redact(text, io.env))
  return 0
}

export function statusCommand(
  argv: readonly string[],
  io: Pick<CliIo, 'out' | 'err' | 'cwd' | 'env'>,
  now: () => number = Date.now,
): number {
  return readState(argv, io, STATUS_USAGE, false, (reader, _config, db) =>
    formatStatus(statusView(reader, { daemon: writerActive(db), now: now() })),
  )
}

export function needsCommand(
  argv: readonly string[],
  io: Pick<CliIo, 'out' | 'err' | 'cwd' | 'env'>,
  now: () => number = Date.now,
): number {
  return readState(argv, io, NEEDS_USAGE, true, (reader, config, _db, all) =>
    formatNeeds(
      needsView(reader, { all, endedWithinMs: config.retention.endedTicketDays * 86_400_000, now: now() }),
      all,
    ),
  )
}
