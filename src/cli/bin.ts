import { redactor, REDACTED } from '../infra/redact.ts'
import { logFormat } from './log-format.ts'

/** After main() returns, the process exits on its own; if something still holds the event loop, it is ended this long after. */
const EXIT_GRACE_MS = 3_000
const argv = process.argv.slice(2)
const json = argv[0] === 'start' && logFormat(argv.slice(1), process.env) === 'json'
const mask = redactor(process.env, REDACTED)
const event = (level: 'warn' | 'error', name: string, detail: string): string =>
  mask(JSON.stringify({ level, at: new Date().toISOString(), event: name, detail })) + '\n'
if (json) {
  // Before anything else loads (node:sqlite warns on load): Node warnings and uncaught errors become JSON events on stdout.
  process.removeAllListeners('warning')
  process.on('warning', warning => {
    process.stdout.write(event('warn', 'node.warning', `${warning.name}: ${warning.message}`))
  })
  process.on('uncaughtException', error => {
    process.stdout.write(event('error', 'cli.failed', String(error)))
    process.exit(1)
  })
}
const exitSoon = (): void => {
  setTimeout(() => {
    process.exit()
  }, EXIT_GRACE_MS).unref()
}

import('./main.ts')
  .then(({ main }) =>
    main(argv, {
      out: s => {
        process.stdout.write(s)
      },
      err: s => {
        process.stderr.write(s)
      },
      cwd: process.cwd(),
      env: process.env,
      signals: process,
    }),
  )
  .then(
    code => {
      process.exitCode = code
      exitSoon()
    },
    (error: unknown) => {
      if (json) process.stdout.write(event('error', 'cli.failed', String(error)))
      else process.stderr.write(`superagent-claude: ${String(error)}\n`)
      process.exitCode = 1
      exitSoon()
    },
  )
