/** The git inspection request checks and argv: fixed safety flags, bounded limits and bounded output. */
import { describe, expect, it } from 'vitest'
import { GIT_INSPECT_LIMITS, gitInspectArgv, truncateOutput } from '../src/executor/git-inspect.ts'

describe('git inspect requests', () => {
  it('rejects commands other than diff, log, show and blame', () => {
    for (const command of ['status', 'push', 'config']) {
      expect(() => gitInspectArgv({ command: command as never })).toThrow(/only diff, log, show and blame/)
    }
  })

  it('rejects unsafe revisions', () => {
    for (const rev of ['-c x', '--output=f', 'a;b', '$(x)', 'a b', ':x', 'a..b..c', '-x', '']) {
      expect(() => gitInspectArgv({ command: 'diff', rev })).toThrow(/rev must be/)
    }
  })

  it('rejects a range for show and blame', () => {
    expect(() => gitInspectArgv({ command: 'show', rev: 'a..b' })).toThrow(/A range works only with diff and log/)
    expect(() => gitInspectArgv({ command: 'blame', rev: 'a...b', path: 'f' })).toThrow(
      /A range works only with diff and log/,
    )
  })

  it('rejects unsafe paths', () => {
    const paths = ['/etc/passwd', '../x', 'a/../b', '-x', ':(top)x', 'a\0b', 'a//b', './a', 'a\\b', 'x'.repeat(501)]
    for (const path of paths) {
      expect(() => gitInspectArgv({ command: 'diff', path })).toThrow(/path must be/)
    }
    expect(() => gitInspectArgv({ command: 'blame' })).toThrow(/blame needs a path/)
  })

  it('bounds limit per command', () => {
    expect(() => gitInspectArgv({ command: 'diff', limit: 0 })).toThrow(/limit must be a whole number from 1 to 2000/)
    expect(() => gitInspectArgv({ command: 'diff', limit: 2001 })).toThrow(
      /limit must be a whole number from 1 to 2000/,
    )
    expect(() => gitInspectArgv({ command: 'diff', limit: 1 })).not.toThrow()
    expect(() => gitInspectArgv({ command: 'diff', limit: 2000 })).not.toThrow()
    expect(() => gitInspectArgv({ command: 'log', limit: 0 })).toThrow(/from 1 to 100/)
    expect(() => gitInspectArgv({ command: 'log', limit: 101 })).toThrow(/from 1 to 100/)
    expect(() => gitInspectArgv({ command: 'log', limit: 100 })).not.toThrow()
    expect(() => gitInspectArgv({ command: 'diff', limit: 1.5 })).toThrow(/limit must be a whole number/)
  })

  it('builds the argv with fixed safety flags, path after --, and no input element starting with -', () => {
    const allowed = [
      '--no-pager',
      '--no-optional-locks',
      '-c',
      '--literal-pathspecs',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '-n',
      '--end-of-options',
      '--',
    ]
    const log = gitInspectArgv({ command: 'log', rev: 'main~2..HEAD', path: 'src/a.ts', limit: 5 })
    expect(log.argv).toEqual([
      '--no-pager',
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '--literal-pathspecs',
      'log',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '-n',
      '5',
      '--end-of-options',
      'main~2..HEAD',
      '--',
      'src/a.ts',
    ])
    expect(log.revs).toEqual(['main~2', 'HEAD'])

    for (const request of [
      { command: 'diff' as const, rev: 'HEAD~1', path: 'src/a.ts' },
      { command: 'show' as const, rev: 'HEAD', path: 'src/a.ts' },
    ]) {
      const { argv } = gitInspectArgv(request)
      for (const flag of [
        '--no-pager',
        '--literal-pathspecs',
        'core.fsmonitor=false',
        '--no-ext-diff',
        '--no-textconv',
        '--end-of-options',
      ]) {
        expect(argv).toContain(flag)
      }
      expect(argv.indexOf('src/a.ts')).toBe(argv.indexOf('--') + 1)
    }

    const cases = [
      log.argv,
      gitInspectArgv({ command: 'diff', rev: 'HEAD~1', path: 'src/a.ts' }).argv,
      gitInspectArgv({ command: 'show', rev: 'HEAD', path: 'src/a.ts' }).argv,
      gitInspectArgv({ command: 'blame', path: 'src/a.ts' }).argv,
    ]
    for (const argv of cases) {
      for (const element of argv) {
        if (element.startsWith('-')) expect(allowed).toContain(element)
      }
    }
  })

  it('puts the blame path after --end-of-options', () => {
    expect(gitInspectArgv({ command: 'blame', path: 'a.ts' })).toMatchObject({ revs: ['HEAD'] })
    const head = gitInspectArgv({ command: 'blame', path: 'a.ts' }).argv
    expect(head.slice(-3)).toEqual(['--end-of-options', 'HEAD', 'a.ts'])
    const pinned = gitInspectArgv({ command: 'blame', rev: 'abc123', path: 'a.ts' })
    expect(pinned.argv.slice(-3)).toEqual(['--end-of-options', 'abc123', 'a.ts'])
    expect(pinned.revs).toEqual(['abc123'])
  })

  it('defaults the line cap per command', () => {
    expect(gitInspectArgv({ command: 'diff' }).maxLines).toBe(400)
    expect(gitInspectArgv({ command: 'diff', limit: 50 }).maxLines).toBe(50)
    const log = gitInspectArgv({ command: 'log' })
    expect(log.maxLines).toBe(2000)
    expect(log.argv).toContain('-n')
    expect(log.argv[log.argv.indexOf('-n') + 1]).toBe('20')
  })

  it('truncates output by lines and bytes and says so', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n')
    const cut = truncateOutput(lines, 400, GIT_INSPECT_LIMITS.outputBytes).split('\n')
    expect(cut).toHaveLength(401)
    expect(cut.at(-1)).toMatch(/^\[output truncated: 2600 more lines; narrow the path, rev or limit\]$/)

    const huge = 'x'.repeat(100_000) + '\nend'
    const bytes = truncateOutput(huge, 400, GIT_INSPECT_LIMITS.outputBytes)
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(GIT_INSPECT_LIMITS.outputBytes + 100)
    expect(bytes).toContain('[output truncated:')

    expect(truncateOutput('a\nb\n', 10_000, GIT_INSPECT_LIMITS.outputBytes)).toBe('a\nb\n')
  })
})
