import pkg from '../../package.json' with { type: 'json' }

export const VERSION: string = pkg.version

export const HELP: string = [
  'Usage: superagent-claude [--help | --version]',
  '',
  'Options:',
  '  -h, --help     Show this help',
  '  -v, --version  Show the version',
].join('\n') + '\n'

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
