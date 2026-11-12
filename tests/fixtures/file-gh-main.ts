/** Entry run by the `gh` script fileGh writes: runs one call against the shared state file and mirrors its output. */
import { runFileGh } from './file-gh.ts'

const [file, ...argv] = process.argv.slice(2)
const result = await runFileGh(file!, argv)
if (result.killParent) process.kill(process.ppid, 'SIGKILL')
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exitCode = result.code
