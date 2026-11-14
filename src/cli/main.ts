import { dirname, resolve } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { CONFIG_FILE, loadConfig, StartupRefused, type Config } from '../app/config.ts'
import { createAgent, type Agent } from '../app/agent.ts'
import { assertStartupPolicy, resolveCredential, type Credential, type StartupReport } from '../app/credentials.ts'
import { installedSources, type InstalledSources } from '../app/sources.ts'
import { jsonLines, Runtime } from '../app/runtime.ts'
import { redactor, REDACTED } from '../infra/redact.ts'
import type { FakeScript } from '../runtimes/fake/runtime.ts'
import { healthCommand } from './health.ts'
import { logFormat, type LogFormat } from './log-format.ts'
import { promptsCommand } from './prompts.ts'
import { needsCommand, statusCommand } from './status.ts'

export const VERSION: string = pkg.version

export const EXIT_REFUSED = 2

/** The fake worker reports ready on its first turn, so a fake run answers once. */
const FAKE_SCRIPT: FakeScript = ({ index }) =>
  index === 0
    ? { tools: [{ name: 'orchestrator_report', args: { state: 'ready', summary: 'Done: the fake worker finished' } }] }
    : {}
/**
 * With ISSUECREW_FAKE_HOLD=1 (read only with --fake) the fake worker never ends a turn, so a test can stop
 * the daemon while an Assignment runs.
 */
const HOLD_SCRIPT: FakeScript = () => ({ hold: new Promise<never>(() => {}) })
const fakeScript = (env: CliIo['env']): FakeScript => (env.ISSUECREW_FAKE_HOLD === '1' ? HOLD_SCRIPT : FAKE_SCRIPT)

export const HELP: string =
  [
    'Usage: issuecrew [--help | --version]',
    '       issuecrew start [--config <path>] [--fake] [--log-format text|json]',
    '       issuecrew status [--config <path>]',
    '       issuecrew needs [--all] [--config <path>]',
    '       issuecrew prompts diff [--config <path>]',
    '       issuecrew health --live|--ready [--config <path>]',
    '',
    'Commands:',
    '  start          Run the daemon in the foreground',
    '  status         Show running work, waiting tickets, recent errors, repository access and consent',
    '  needs          List the tickets that wait for a person',
    '  prompts diff   Show built-in prompt changes since the team sections were made',
    '  health         Exit 0 when the daemon is live (--live) or ready for work (--ready), 1 otherwise',
    '',
    'Options:',
    '  -h, --help     Show this help',
    '  -v, --version  Show the version',
    '  --config PATH  Config file (default: ./issuecrew.json)',
    '  --fake         Use the scripted fake runtime (no model calls)',
    '  --log-format F  With start: text (default) or json, one JSON event per line on stdout only (env ISSUECREW_LOG_FORMAT)',
    '  --all          With needs: also list the other open tickets and the tickets ended within retention.endedTicketDays',
    '',
    'Exit codes: 0 done, 1 unknown argument or failed health check, 2 refused start, config error or bad health arguments, 3 no readable state database (status, needs)',
  ].join('\n') + '\n'

export interface CliIo {
  out(s: string): void
  err(s: string): void
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  signals: {
    once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
    on?(signal: 'SIGHUP', listener: () => void): unknown
    off?(signal: 'SIGHUP', listener: () => void): unknown
  }
}

export function run(argv: readonly string[], out: (s: string) => void, err: (s: string) => void): number {
  const first = argv[0]
  if (first === undefined || first === '--help' || first === '-h') {
    out(HELP)
    return 0
  }
  if (first === '--version' || first === '-v') {
    out(`issuecrew ${VERSION}\n`)
    return 0
  }
  err(`issuecrew: unknown argument '${first}'\n` + HELP)
  return 1
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv[0] === 'start') return start(argv.slice(1), io)
  if (argv[0] === 'prompts') return promptsCommand(argv.slice(1), io)
  if (argv[0] === 'status') return statusCommand(argv.slice(1), io)
  if (argv[0] === 'needs') return needsCommand(argv.slice(1), io)
  if (argv[0] === 'health') return healthCommand(argv.slice(1), io)
  return run(argv, io.out, io.err)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface StartOutput {
  refuse(message: string, usage?: boolean): number
  warn(message: string): void
}

function startOutput(format: LogFormat, io: CliIo): StartOutput {
  const mask = redactor(io.env, REDACTED)
  if (format === 'json') {
    const event = (level: 'warn' | 'error', name: string, detail: string): string =>
      mask(JSON.stringify({ level, at: new Date().toISOString(), event: name, detail })) + '\n'
    return {
      refuse: message => {
        io.out(event('error', 'cli.refused', message))
        return EXIT_REFUSED
      },
      warn: message => {
        io.out(event('warn', 'startup.warning', message))
      },
    }
  }
  return {
    refuse: (message, usage = false) => {
      io.err(mask(`issuecrew: ${message}\n` + (usage ? HELP : '')))
      return EXIT_REFUSED
    },
    warn: message => {
      io.err(mask(`issuecrew: warning: ${message}\n`))
    },
  }
}

async function start(argv: readonly string[], io: CliIo): Promise<number> {
  const format = logFormat(argv, io.env)
  if (format === undefined) {
    io.err(`issuecrew: --log-format and ISSUECREW_LOG_FORMAT take text or json\n` + HELP)
    return EXIT_REFUSED
  }
  const say = startOutput(format, io)
  let fake = false
  let configArg: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--fake') {
      fake = true
    } else if (arg === '--log-format') {
      i++
    } else if (arg === '--config') {
      const value = argv[i + 1]
      if (value === undefined) return say.refuse(`option '--config' needs a path`, true)
      configArg = value
      i++
    } else {
      return say.refuse(`unknown option '${arg}'`, true)
    }
  }

  const path = resolve(io.cwd, configArg ?? CONFIG_FILE)
  let config: Config
  try {
    config = loadConfig(path, io.env)
  } catch (error) {
    if (error instanceof StartupRefused) return say.refuse(error.message)
    throw error
  }

  const log = jsonLines(io.out, io.env)
  let agent: Agent
  let credential: Credential
  let report: StartupReport
  let sources: InstalledSources
  try {
    credential = resolveCredential(config.auth.mode, io.env)
    agent = createAgent({ config, credential, env: io.env, log, ...(fake ? { fake: fakeScript(io.env) } : {}) })
    report = assertStartupPolicy(config, credential, undefined, await agent.runtime.probe())
    sources = installedSources(config, io.env)
  } catch (error) {
    if (error instanceof StartupRefused) return say.refuse(error.message)
    throw error
  }
  for (const warning of report.warnings) say.warn(warning)

  let runtime: Runtime
  try {
    runtime = new Runtime({
      config,
      configDir: dirname(path),
      configPath: path,
      env: io.env,
      runtime: agent.runtime,
      workspaces: agent.workspaces,
      router: agent.router,
      log,
      startup: report,
      ...sources,
    })
  } catch (error) {
    return say.refuse(messageOf(error))
  }

  // Listen before starting, so a signal during startup stops the runtime in order instead of killing the process.
  const signal = { received: false }
  const signalled = new Promise<void>(done => {
    const onSignal = (): void => {
      signal.received = true
      done()
    }
    io.signals.once('SIGINT', onSignal)
    io.signals.once('SIGTERM', onSignal)
  })
  const starting = runtime.start()
  starting.catch(() => {})
  try {
    await Promise.race([starting, signalled])
  } catch (error) {
    await runtime.stop()
    return say.refuse(messageOf(error))
  }
  if (!signal.received) {
    const onHup = (): void => {
      void runtime.reload()
    }
    io.signals.on?.('SIGHUP', onHup)
    await signalled
    io.signals.off?.('SIGHUP', onHup)
  }
  await runtime.stop()
  return 0
}
