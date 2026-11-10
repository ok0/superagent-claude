import { resolve } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { CONFIG_FILE, ConfigError, loadConfig, type Config } from '../app/config.ts'
import { jsonLines, Runtime } from '../app/runtime.ts'
import { FakeRuntime } from '../runtimes/fake/runtime.ts'

export const VERSION: string = pkg.version

export const EXIT_REFUSED = 2

export const HELP: string = [
  'Usage: superagent-claude [--help | --version]',
  '       superagent-claude start [--config <path>] [--fake]',
  '',
  'Commands:',
  '  start          Run the daemon in the foreground',
  '',
  'Options:',
  '  -h, --help     Show this help',
  '  -v, --version  Show the version',
  '  --config PATH  Config file (default: ./superagent-claude.json)',
  '  --fake         Use the scripted fake runtime (no model calls)',
].join('\n') + '\n'

export interface CliIo {
  out(s: string): void
  err(s: string): void
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  signals: { once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown }
}

export function run(
  argv: readonly string[],
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const first = argv[0]
  if (first === undefined || first === '--help' || first === '-h') {
    out(HELP)
    return 0
  }
  if (first === '--version' || first === '-v') {
    out(`superagent-claude ${VERSION}\n`)
    return 0
  }
  err(`superagent-claude: unknown argument '${first}'\n` + HELP)
  return 1
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv[0] === 'start') return start(argv.slice(1), io)
  return run(argv, io.out, io.err)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function start(argv: readonly string[], io: CliIo): Promise<number> {
  let fake = false
  let configArg: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--fake') {
      fake = true
    } else if (arg === '--config') {
      const value = argv[i + 1]
      if (value === undefined) {
        io.err(`superagent-claude: option '--config' needs a path\n` + HELP)
        return EXIT_REFUSED
      }
      configArg = value
      i++
    } else {
      io.err(`superagent-claude: unknown option '${arg}'\n` + HELP)
      return EXIT_REFUSED
    }
  }

  const path = resolve(io.cwd, configArg ?? CONFIG_FILE)
  let config: Config
  try {
    config = loadConfig(path, io.env)
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(`superagent-claude: ${error.message}\n`)
      return EXIT_REFUSED
    }
    throw error
  }

  if (!fake) {
    io.err('superagent-claude: only start --fake is available in this build\n')
    return EXIT_REFUSED
  }

  let runtime: Runtime
  try {
    runtime = new Runtime({ config, runtime: new FakeRuntime(() => ({})), log: jsonLines(io.out) })
  } catch (error) {
    io.err(`superagent-claude: ${messageOf(error)}\n`)
    return EXIT_REFUSED
  }

  try {
    await runtime.start()
  } catch (error) {
    await runtime.stop()
    io.err(`superagent-claude: ${messageOf(error)}\n`)
    return EXIT_REFUSED
  }

  await new Promise<void>(done => {
    io.signals.once('SIGINT', done)
    io.signals.once('SIGTERM', done)
  })
  await runtime.stop()
  return 0
}
