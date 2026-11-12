/**
 * The daemon's log format: `start --log-format text|json` or env SUPERAGENT_CLAUDE_LOG_FORMAT. No imports, so the
 * entry can read it before loading the rest.
 */

export type LogFormat = 'text' | 'json'
export const LOG_FORMAT_ENV = 'SUPERAGENT_CLAUDE_LOG_FORMAT'

export function logFormat(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): LogFormat | undefined {
  let value: string | undefined = env[LOG_FORMAT_ENV] || undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--config') {
      i++
    } else if (arg === '--log-format') {
      value = argv[i + 1]
      if (value === undefined) return undefined
      i++
    }
  }
  if (value === undefined) return 'text'
  return value === 'text' || value === 'json' ? value : undefined
}
