/**
 * Validation and argv construction for read-only git inspection (diff, log, show, blame).
 * Pure: it imports nothing and runs no git. Every element that comes from the request is either a validated
 * revision or a validated repository-relative path, and fixed flags disable external diff, textconv and fsmonitor.
 */

export type GitInspectCommand = 'diff' | 'log' | 'show' | 'blame'

export const GIT_INSPECT_COMMANDS: readonly GitInspectCommand[] = ['diff', 'log', 'show', 'blame']

export interface GitInspectRequest {
  command: GitInspectCommand
  rev?: string
  path?: string
  limit?: number
}

export const GIT_INSPECT_LIMITS = {
  logDefault: 20,
  logMax: 100,
  linesDefault: 400,
  linesMax: 2000,
  outputBytes: 65_536,
  timeoutMs: 10_000,
} as const

/** Disables the repository's own pager, optional locks and fsmonitor hook for every read. */
export const GIT_READ_OPTIONS = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false'] as const

const TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_./@{}^~-]{0,199}$/

function validToken(token: string): boolean {
  return TOKEN.test(token) && !token.includes('..')
}

function revisions(rev: string): { revs: string[]; range: boolean } {
  const parts = rev.includes('...') ? rev.split('...') : rev.includes('..') ? rev.split('..') : [rev]
  if (parts.length > 2 || !parts.every(validToken))
    throw new Error(
      'rev must be one revision or a range a..b or a...b; a revision uses letters, digits and _ . / @ { } ^ ~ - and does not start with - or :',
    )
  return { revs: parts, range: parts.length === 2 }
}

function checkPath(path: string): void {
  if (
    path === '' ||
    path.length > 500 ||
    path.includes('\0') ||
    path.includes('\\') ||
    /^[-:/]/.test(path) ||
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  )
    throw new Error(
      'path must be a relative path inside the repository: no leading -, : or /, no . or .. segments, no backslash or NUL, at most 500 characters',
    )
}

export function gitInspectArgv(request: GitInspectRequest): { argv: string[]; revs: string[]; maxLines: number } {
  const { command, rev, path, limit } = request
  if (!GIT_INSPECT_COMMANDS.includes(command)) throw new Error('git_inspect supports only diff, log, show and blame')
  let revs: string[] = []
  if (rev !== undefined) {
    const parsed = revisions(rev)
    if (parsed.range && (command === 'show' || command === 'blame'))
      throw new Error('A range works only with diff and log; give show and blame one revision')
    revs = parsed.revs
  }
  if (path !== undefined) checkPath(path)
  if (command === 'blame' && path === undefined) throw new Error('blame needs a path')
  const max = command === 'log' ? GIT_INSPECT_LIMITS.logMax : GIT_INSPECT_LIMITS.linesMax
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= max))
    throw new Error(`limit must be a whole number from 1 to ${max} for ${command}`)
  if (command === 'blame') {
    return {
      argv: [
        ...GIT_READ_OPTIONS,
        '--literal-pathspecs',
        'blame',
        '--no-ext-diff',
        '--no-textconv',
        '--end-of-options',
        rev ?? 'HEAD',
        path as string,
      ],
      revs: [rev ?? 'HEAD'],
      maxLines: limit ?? GIT_INSPECT_LIMITS.linesDefault,
    }
  }
  const argv = [
    ...GIT_READ_OPTIONS,
    '--literal-pathspecs',
    command,
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    ...(command === 'log' ? ['-n', String(limit ?? GIT_INSPECT_LIMITS.logDefault)] : []),
    '--end-of-options',
    ...(rev !== undefined ? [rev] : []),
    '--',
    ...(path !== undefined ? [path] : []),
  ]
  return {
    argv,
    revs,
    maxLines: command === 'log' ? GIT_INSPECT_LIMITS.linesMax : (limit ?? GIT_INSPECT_LIMITS.linesDefault),
  }
}

export function truncateOutput(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const totalLines = lines.length
  let kept = lines.slice(0, maxLines).join('\n')
  const cutBytes = Buffer.byteLength(kept) > maxBytes
  if (cutBytes) {
    kept = Buffer.from(kept).subarray(0, maxBytes).toString('utf8').replace(/�+$/, '')
    const newline = kept.lastIndexOf('\n')
    if (newline >= 0) kept = kept.slice(0, newline)
  }
  if (!cutBytes && totalLines <= maxLines) return text
  const keptLines = kept === '' ? 0 : kept.split('\n').length
  const omitted = Math.max(1, totalLines - keptLines)
  return kept + '\n[output truncated: ' + omitted + ' more lines; narrow the path, rev or limit]'
}
