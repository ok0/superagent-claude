/** superagent-claude health --live|--ready: the exec probe. It reads the state database read-only and the lock owner file, and exits 0 when the check passes, 1 when it fails, 2 for bad arguments. */
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { CONFIG_FILE, loadConfig, type Config } from '../app/config.ts'
import { KV, type RuntimeReady } from '../app/kv.ts'
import { databasePath, lockOwner } from '../app/store.ts'
import { openReadOnly, writerActive, type StoreReader } from '../app/store-read.ts'
import type { HealthSnapshot } from '../infra/health.ts'
import type { CliIo } from './main.ts'

export const HEALTH_USAGE = 'Usage: superagent-claude health --live|--ready [--config <path>]\n'
export const LIVE_SNAPSHOT_MS = 60_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

export function healthCommand(
  argv: readonly string[],
  io: Pick<CliIo, 'out' | 'err' | 'cwd' | 'env'>,
  now: () => number = Date.now,
): number {
  let mode: 'live' | 'ready' | undefined
  let configArg: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--live' || arg === '--ready') {
      if (mode !== undefined) {
        io.err(`superagent-claude: choose one of --live or --ready\n` + HEALTH_USAGE)
        return 2
      }
      mode = arg === '--live' ? 'live' : 'ready'
    } else if (arg === '--config') {
      const value = argv[i + 1]
      if (value === undefined) {
        io.err(`superagent-claude: option '--config' needs a path\n` + HEALTH_USAGE)
        return 2
      }
      configArg = value
      i++
    } else {
      io.err(`superagent-claude: unknown option '${arg}'\n` + HEALTH_USAGE)
      return 2
    }
  }
  if (mode === undefined) {
    io.err(`superagent-claude: health needs --live or --ready\n` + HEALTH_USAGE)
    return 2
  }
  const checked = mode

  const fail = (reason: string): number => {
    io.err(`superagent-claude: not ${checked}: ${reason}\n`)
    return 1
  }

  let config: Config
  try {
    config = loadConfig(resolve(io.cwd, configArg ?? CONFIG_FILE), io.env)
  } catch (error) {
    return fail(firstLine(messageOf(error)))
  }

  const db = databasePath(config.stateDir)
  if (!existsSync(db)) return fail(`no state database at ${db}`)

  const owner = lockOwner(db)
  if (!owner) return fail('no process holds the state lock')
  if (owner.host !== undefined && owner.host !== hostname()) return fail(`the state lock is held on host ${owner.host}`)
  if (!writerActive(db)) return fail(`the process ${owner.pid} holding the state lock is not running`)

  let snapshot: HealthSnapshot | undefined
  let marker: RuntimeReady | undefined
  let reader: StoreReader
  try {
    reader = openReadOnly(db)
  } catch (error) {
    return fail(`cannot read the state database: ${firstLine(messageOf(error))}`)
  }
  try {
    snapshot = reader.get(KV.health.snapshot)
    marker = reader.get(KV.runtime.ready)
  } catch (error) {
    return fail(`cannot read the state database: ${firstLine(messageOf(error))}`)
  } finally {
    reader.close()
  }

  if (!snapshot || snapshot.pid !== owner.pid) return fail('no health snapshot from the running daemon')
  const age = now() - Date.parse(snapshot.at)
  if (!(age <= LIVE_SNAPSHOT_MS)) return fail(`the health snapshot is ${Math.round(age / 1000)}s old`)
  if (checked === 'ready' && (!marker || marker.pid !== owner.pid))
    return fail('the daemon has not finished starting or is stopping')

  io.out(`${checked}\n`)
  return 0
}
