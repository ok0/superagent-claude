import { run } from './main.ts'

process.exitCode = run(
  process.argv.slice(2),
  (s) => process.stdout.write(s),
  (s) => process.stderr.write(s),
)
