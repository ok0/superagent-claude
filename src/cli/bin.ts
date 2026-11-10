import { main } from './main.ts'

main(process.argv.slice(2), {
  out: s => { process.stdout.write(s) },
  err: s => { process.stderr.write(s) },
  cwd: process.cwd(),
  env: process.env,
  signals: process,
}).then(
  code => { process.exitCode = code },
  (error: unknown) => {
    process.stderr.write(`superagent-claude: ${String(error)}\n`)
    process.exitCode = 1
  },
)
