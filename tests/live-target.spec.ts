import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertAllowedRepo, assertApiTarget, isAllowedRepo } from './live/guard.ts'
import { LiveTargetError, liveEnabled, liveTarget, renderLiveText } from './live/target.ts'
import { EXAMPLE_TARGET, EXAMPLE_TARGET_ENV } from './fixtures/live-target.ts'

const E = EXAMPLE_TARGET_ENV
const TESTS_DIR = import.meta.dirname
const LITERAL = 'ok' + '0'

// each entry: path under tests/ and why the literal must stay
export const OK0_LITERAL_ALLOWED: readonly { file: string; reason: string }[] = []

function ok0Hits(entries: readonly (readonly [string, string])[], allowed: readonly { file: string }[]): string[] {
  const allowedFiles = new Set(allowed.map(entry => entry.file))
  return entries.flatMap(([name, text]) =>
    allowedFiles.has(name)
      ? []
      : text.split('\n').flatMap((line, index) => (/\bok0\b/.test(line) ? [name + ':' + (index + 1)] : [])),
  )
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    if (name === 'node_modules') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })
}

function scannedFiles(): [string, string][] {
  const paths = [
    ...listFiles(join(TESTS_DIR, 'live')),
    ...listFiles(join(TESTS_DIR, 'fixtures')),
    ...readdirSync(TESTS_DIR)
      .filter(name => /^live-.*\.spec\.ts$/.test(name))
      .map(name => join(TESTS_DIR, name)),
  ]
  return paths.map(path => [relative(TESTS_DIR, path).split(sep).join('/'), readFileSync(path, 'utf8')])
}

const GITHUB_SPECS = [
  'code-change.spec.ts',
  'conversation-quality.spec.ts',
  'conversation.spec.ts',
  'crash-restart.spec.ts',
  'issue-reply.spec.ts',
  'pr-delivery.spec.ts',
  'private-workspace.spec.ts',
]
const CLAUDE_ONLY_SPECS = [
  'claude-auth.spec.ts',
  'claude-contract.spec.ts',
  'claude-resume.spec.ts',
  'guard-denial.spec.ts',
  'repo-config.spec.ts',
  'review-apply.spec.ts',
  'sandbox-linux.spec.ts',
  'subagent.spec.ts',
]

describe('live target', () => {
  it('no target without the repository setting', () => {
    expect(liveTarget({})).toBeNull()
    expect(liveTarget({ SUPERAGENT_CLAUDE_LIVE_REPO: '' })).toBeNull()
    expect(liveTarget({ SUPERAGENT_CLAUDE_LIVE_REPO: '  ' })).toBeNull()
    expect(liveEnabled({ SUPERAGENT_CLAUDE_LIVE: '1' })).toBe(false)
    expect(liveEnabled({ ...E })).toBe(false)
    expect(liveEnabled({ ...E, SUPERAGENT_CLAUDE_LIVE: '1' })).toBe(true)
  })

  it('reads the target', () => {
    expect(liveTarget(E)).toEqual(EXAMPLE_TARGET)
    const withoutReport = liveTarget({ ...E, SUPERAGENT_CLAUDE_LIVE_REPORT_REPO: undefined })
    expect(withoutReport).not.toBeNull()
    expect(Object.keys(withoutReport!)).not.toContain('reportRepo')
  })

  it('rejects bad settings', () => {
    expect(() => liveTarget({ ...E, SUPERAGENT_CLAUDE_LIVE_OWNER_LOGIN: undefined })).toThrow(LiveTargetError)
    expect(() => liveTarget({ ...E, SUPERAGENT_CLAUDE_LIVE_AGENT_LOGIN: undefined })).toThrow(LiveTargetError)
    for (const repo of ['example', 'example/x/y', ' example/x', 'https://github.com/example/x']) {
      expect(() => liveTarget({ ...E, SUPERAGENT_CLAUDE_LIVE_REPO: repo })).toThrow(LiveTargetError)
    }
    expect(() => liveTarget({ ...E, SUPERAGENT_CLAUDE_LIVE_REPO: 'example' })).toThrow(/"example"/)
    for (const login of ['bad login', 'a@b']) {
      expect(() => liveTarget({ ...E, SUPERAGENT_CLAUDE_LIVE_OWNER_LOGIN: login })).toThrow(LiveTargetError)
      expect(() => liveTarget({ ...E, SUPERAGENT_CLAUDE_LIVE_AGENT_LOGIN: login })).toThrow(LiveTargetError)
    }
    for (const report of ['example/playground', 'Example/PLAYGROUND', 'nope']) {
      expect(() => liveTarget({ ...E, SUPERAGENT_CLAUDE_LIVE_REPORT_REPO: report })).toThrow(LiveTargetError)
    }
    expect(() => liveEnabled({ ...E, SUPERAGENT_CLAUDE_LIVE: '1', SUPERAGENT_CLAUDE_LIVE_REPO: 'bad' })).toThrow(
      LiveTargetError,
    )
  })

  it('does not read tokens', () => {
    const source = readFileSync(join(import.meta.dirname, 'live', 'target.ts'), 'utf8')
    expect(source).not.toContain('TOKEN')
  })

  it('renders placeholders', () => {
    expect(renderLiveText('@{{agent}} hi {{owner}} in {{repo}}', EXAMPLE_TARGET)).toBe(
      '@example-agent hi example-owner in example/playground',
    )
    expect(() => renderLiveText('{{other}}', EXAMPLE_TARGET)).toThrow(/unknown placeholder/)
    expect(renderLiveText('plain text', EXAMPLE_TARGET)).toBe('plain text')
  })

  it('guard refuses everything without a target', () => {
    const calls: string[][] = [
      ['repos/x/y/issues'],
      ['graphql', '-f', 'query=query { repository(owner: "x", name: "y") { id } }'],
      ['user'],
    ]
    for (const args of calls) {
      expect(() => assertApiTarget(args, {})).toThrow(/live target not configured/)
    }
    expect(() => assertAllowedRepo('x/y', {})).toThrow(/live target not configured/)
    expect(isAllowedRepo('x/y', {})).toBe(false)
  })

  it('guard follows the configured target', () => {
    const allowed: string[][] = [
      ['repos/example/playground/issues', '-X', 'POST', '-f', 'title=x'],
      ['repos/Example/Playground/issues', '-X', 'POST'],
      ['repos/example/playground/pulls/3/merge', '-X', 'PUT'],
      ['repos/example/main/issues'],
      ['repos/example/main/pulls?state=open'],
      ['graphql', '-f', 'query=query { repository(owner: "example", name: "main") { id } }'],
      ['user'],
    ]
    for (const args of allowed) {
      expect(() => assertApiTarget(args, E), args.join(' ')).not.toThrow()
    }
    const rejected: string[][] = [
      ['repos/example/playground2/issues'],
      ['repos/someone/playground/issues'],
      ['repos/someone/main/issues'],
      ['repos/other/x'],
      ['repos/example/main/issues', '-X', 'POST'],
      ['repos/example/main/issues', '-f', 'title=x'],
      ['repos/example/main/issues/1', '--method', 'PATCH'],
      ['repos/example/main/pulls/3/merge', '-X', 'PUT'],
      ['repos/other/x/pulls/3/merge', '-X', 'PUT'],
      ['repos/example/playground/pulls/3', '-X', 'PUT'],
      ['graphql', '-f', 'query=mutation { x }'],
      ['graphql', '-f', 'query=query { repository(owner: "someone", name: "playground") { id } }'],
      ['repos/example/playground', '--hostname', 'example.com'],
    ]
    for (const args of rejected) {
      expect(() => assertApiTarget(args, E), args.join(' ')).toThrow()
    }
    expect(isAllowedRepo('someone/playground', E)).toBe(false)
  })

  it('tests have no ' + LITERAL + ' literal', () => {
    const files = scannedFiles()
    const names = files.map(([name]) => name)
    expect(names).toEqual(expect.arrayContaining(['fixtures/live-target.ts', 'live-target.spec.ts', 'live/gh.ts']))
    expect(ok0Hits(files, OK0_LITERAL_ALLOWED)).toEqual([])
  })

  it('the literal scan catches a sample', () => {
    const SAMPLE = '@' + 'ok' + '0-worker' // split so this file passes its own scan
    expect(ok0Hits([['sample.ts', "const a = 'x'\nconst b = '" + SAMPLE + "'"]], [])).toEqual(['sample.ts:2'])
    expect(ok0Hits([['sample.ts', "const a = 'x'\nconst b = '" + SAMPLE + "'"]], [{ file: 'sample.ts' }])).toEqual([])
    expect(ok0Hits([['s.ts', 'took0 ok01']], [])).toEqual([])
  })

  it('allowlist entries carry a reason', () => {
    for (const entry of OK0_LITERAL_ALLOWED) {
      expect(entry.reason.trim()).not.toBe('')
      expect(statSync(join(TESTS_DIR, entry.file)).isFile()).toBe(true)
    }
  })

  it('GitHub live specs gate on the target', () => {
    const LIVE_DIR = join(TESTS_DIR, 'live')
    const specs = readdirSync(LIVE_DIR)
      .filter(name => name.endsWith('.spec.ts'))
      .sort()
    expect(specs).toEqual([...GITHUB_SPECS, ...CLAUDE_ONLY_SPECS].sort())
    const read = (name: string): string => readFileSync(join(LIVE_DIR, name), 'utf8')
    for (const name of GITHUB_SPECS) {
      expect(read(name), name).toContain('const LIVE = liveEnabled()')
      expect(read(name), name).toContain("from './target.ts'")
    }
    const GITHUB_IMPORTS = /from '\.\/(gh|guard|seed-playground|owner-merge)\.ts'/
    for (const name of specs) {
      if (GITHUB_IMPORTS.test(read(name))) expect(GITHUB_SPECS, name).toContain(name)
    }
    for (const name of CLAUDE_ONLY_SPECS) {
      expect(read(name), name).toContain("process.env.SUPERAGENT_CLAUDE_LIVE === '1'")
      expect(read(name), name).not.toContain('./target.ts')
      expect(read(name), name).not.toContain('SUPERAGENT_CLAUDE_LIVE_REPO')
    }
  })
})
