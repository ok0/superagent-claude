import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CATEGORIES, collectCommits, extractNotes, previousTag, renderSection } from '../scripts/changelog.ts'
import { checkText } from '../scripts/check-branding.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../scripts/changelog.ts', import.meta.url))

function cli(args: string[], cwd: string = ROOT) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
}

export const ALLOWED_HEADINGS = ['Breaking changes', 'Features', 'Fixes', 'Performance'] as const

export function changelogProblems(content: string): string[] {
  const problems: string[] = []
  const lines = content.split('\n')
  if (lines[0] !== '# Changelog') problems.push('first line is not # Changelog')
  for (const l of lines.filter((x) => x.startsWith('## ['))) {
    if (!/^## \[\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\] - \d{4}-\d{2}-\d{2}$/.test(l)) problems.push(`bad release heading: ${l}`)
  }
  for (const l of lines.filter((x) => x.startsWith('### '))) {
    if (!(ALLOWED_HEADINGS as readonly string[]).includes(l.slice(4))) problems.push(`heading not allowed: ${l}`)
  }
  return problems
}

const dirs: string[] = []

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-'))
  dirs.push(dir)
  git(dir, ['init', '-q'])
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }, null, 2) + '\n')
  writeFileSync(join(dir, 'CHANGELOG.md'), readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'))
  git(dir, ['add', '.'])
  commit(dir, 'chore: init')
  return dir
}

function git(cwd: string, args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, stdio: 'pipe' },
  )
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' })
}

function commit(cwd: string, message: string): void {
  git(cwd, ['commit', '-q', '--allow-empty', '-m', message])
}

function tag(cwd: string, name: string): void {
  git(cwd, ['tag', name])
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('renderSection', () => {
  const fixture = [
    { sha: 'a'.repeat(40), message: 'feat(cli): add a' },
    { sha: 'b'.repeat(40), message: 'feat: add b' },
    { sha: 'c'.repeat(40), message: 'fix: c' },
    { sha: 'd'.repeat(40), message: 'feat!: drop d' },
    { sha: 'e'.repeat(40), message: 'docs: e' },
    { sha: 'f'.repeat(40), message: 'chore: f' },
    { sha: '1'.repeat(40), message: "Merge branch 'x'" },
    { sha: '2'.repeat(40), message: 'Revert "feat: add a"' },
    { sha: 'g'.repeat(40), message: 'refactor: g\n\nBREAKING CHANGE: h' },
  ]

  it('renders categories in order and omits excluded types', () => {
    const out = renderSection('0.2.0', '2026-01-02', fixture)
    expect(out.startsWith('## [0.2.0] - 2026-01-02\n')).toBe(true)
    const breaking = out.indexOf('### Breaking changes')
    const features = out.indexOf('### Features')
    const fixes = out.indexOf('### Fixes')
    expect(breaking).toBeGreaterThan(-1)
    expect(features).toBeGreaterThan(breaking)
    expect(fixes).toBeGreaterThan(features)
    expect(out).toContain('- cli: add a (aaaaaaa)')
    expect(out).toContain('- add b (')
    const breakingSection = out.slice(breaking, features)
    expect(breakingSection).toContain('drop d')
    expect(breakingSection).toContain('g (')
    expect(out.slice(features)).not.toContain('drop d')
    expect(out.slice(features)).not.toContain('g (')
    expect(out).not.toContain('### Performance')
    expect(out).not.toContain('docs')
    expect(out).not.toContain('e (')
    expect(out).not.toContain('f (')
    expect(out).not.toContain('Merge')
    expect(out).not.toContain('Revert')
  })

  it('renders a perf-only section', () => {
    const out = renderSection('0.2.0', '2026-01-02', [{ sha: 'p'.repeat(40), message: 'perf: speed' }])
    expect(out).toContain('### Performance')
    expect(out).not.toContain('### Features')
  })
})

describe('forbidden content', () => {
  it.each([
    ['feat: wire M12 support', 'pppppppp'],
    ['feat: finish the Milestone work', 'pppppppp'],
    ['feat: add x\n\nCo-Authored-By: Claude <noreply@anthropic.com>', 'pppppppp'],
  ])('blocks %j', (message) => {
    expect(() => renderSection('0.2.0', '2026-01-02', [{ sha: 'p'.repeat(40), message }])).toThrow('ppppppp')
  })

  it('does not block an excluded type', () => {
    expect(() => renderSection('0.2.0', '2026-01-02', [{ sha: 'd'.repeat(40), message: 'docs: M12 notes' }])).not.toThrow()
  })

  it('keeps normal output free of milestone and attribution text', () => {
    const out = renderSection('0.2.0', '2026-01-02', [
      { sha: 'a'.repeat(40), message: 'feat(cli): add a' },
      { sha: 'b'.repeat(40), message: 'fix: c' },
    ])
    expect(out).not.toMatch(/\bM\d+\b/)
    expect(out).not.toMatch(/milestone/i)
    expect(out).not.toMatch(/co-authored-by/i)
  })

  it.each(['feat: wire M12 support', 'feat: finish the Milestone work', 'feat: add x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'])(
    'CLI prepare blocks %j and leaves files unchanged',
    (message) => {
      const dir = repo()
      writeFileSync(join(dir, 'x.txt'), 'x\n')
      git(dir, ['add', 'x.txt'])
      commit(dir, message)
      const changelogBefore = readFileSync(join(dir, 'CHANGELOG.md'))
      const packageBefore = readFileSync(join(dir, 'package.json'))
      const result = cli(['prepare', '0.2.0', '--date', '2026-01-02'], dir)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('changelog blocked')
      expect(readFileSync(join(dir, 'CHANGELOG.md'))).toEqual(changelogBefore)
      expect(readFileSync(join(dir, 'package.json'))).toEqual(packageBefore)
    },
  )
})

describe('previous tag selection', () => {
  function tagged(dir: string): void {
    commit(dir, 'feat: one')
    tag(dir, 'v0.1.0')
    commit(dir, 'feat: two')
    tag(dir, 'v0.2.0-rc.1')
    commit(dir, 'fix: three')
    tag(dir, 'release-x')
  }

  it('selects the previous stable and pre-release tags', () => {
    const dir = repo()
    tagged(dir)
    expect(previousTag('0.2.0', dir)).toBe('v0.1.0')
    expect(previousTag('0.2.0-rc.2', dir)).toBe('v0.2.0-rc.1')
  })

  it('collects commits from the selected base', () => {
    const dir = repo()
    tagged(dir)
    const stable = renderSection('0.2.0', '2026-01-02', collectCommits('0.2.0', dir))
    expect(stable).toContain('two')
    expect(stable).toContain('three')
    expect(stable).not.toContain('one')
    const other = repo()
    tagged(other)
    const rc = renderSection('0.2.0-rc.2', '2026-01-02', collectCommits('0.2.0-rc.2', other))
    expect(rc).toContain('three')
    expect(rc).not.toContain('two')
    expect(rc).not.toContain('one')
  })

  it('uses all commits when there is no tag', () => {
    const dir = repo()
    commit(dir, 'feat: root')
    commit(dir, 'feat: next')
    expect(previousTag('0.2.0', dir)).toBeUndefined()
    const section = renderSection('0.2.0', '2026-01-02', collectCommits('0.2.0', dir))
    expect(section).toContain('root')
    expect(section).toContain('next')
  })
})

describe('prepare and notes', () => {
  it('writes version and section without tagging or committing', () => {
    const dir = repo()
    commit(dir, 'feat: add notes entry')
    const countBefore = gitText(dir, ['rev-list', '--count', 'HEAD']).trim()
    const result = cli(['prepare', '0.2.0', '--date', '2026-01-02'], dir)
    expect(result.status).toBe(0)
    const changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
    const lines = changelog.split('\n')
    const description = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').split('\n')[2]
    expect(lines[0]).toBe('# Changelog')
    expect(lines[2]).toBe(description)
    expect(lines.find((l) => l.startsWith('## ['))).toBe('## [0.2.0] - 2026-01-02')
    expect(changelog.endsWith('\n')).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('0.2.0')
    expect(gitText(dir, ['tag', '-l']).trim()).toBe('')
    expect(gitText(dir, ['rev-list', '--count', 'HEAD']).trim()).toBe(countBefore)
    const status = gitText(dir, ['status', '--porcelain']).split('\n').filter(Boolean).sort()
    expect(status).toEqual([' M CHANGELOG.md', ' M package.json'])

    const again = cli(['prepare', '0.2.0', '--date', '2026-01-02'], dir)
    expect(again.status).toBe(1)
    expect(again.stderr).toContain('already has a section')

    commit(dir, 'fix: later')
    const next = cli(['prepare', '0.3.0', '--date', '2026-02-03'], dir)
    expect(next.status).toBe(0)
    const updated = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
    expect(updated.indexOf('## [0.3.0]')).toBeGreaterThan(-1)
    expect(updated.indexOf('## [0.3.0]')).toBeLessThan(updated.indexOf('## [0.2.0]'))

    const notes = cli(['notes', '0.2.0'], dir)
    expect(notes.status).toBe(0)
    expect(notes.stdout.startsWith('### ')).toBe(true)
    expect(notes.stdout).toContain('notes entry')
    expect(notes.stdout).not.toContain('## [')
    expect(notes.stdout).not.toContain('later')
    expect(cli(['notes', '9.9.9'], dir).status).toBe(1)
    expect(cli(['prepare', 'v0.2.0'], dir).status).toBe(1)
  })

  it('extractNotes returns the body of one section', () => {
    const text = '# Changelog\n\ndesc\n\n## [0.2.0] - 2026-01-02\n\n### Fixes\n\n- a (aaaaaaa)\n\n## [0.1.0] - 2026-01-01\n\n### Fixes\n\n- b (bbbbbbb)\n'
    expect(extractNotes(text, '0.2.0')).toBe('### Fixes\n\n- a (aaaaaaa)')
  })
})

describe('root CHANGELOG.md', () => {
  const content = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')

  it('has the header and well-formed release sections only', () => {
    expect(changelogProblems(content)).toEqual([])
  })

  it('allows exactly the headings the script can emit', () => {
    expect([...ALLOWED_HEADINGS].sort()).toEqual(CATEGORIES.map(([, title]) => title).sort())
  })

  it('accepts a changelog generated from a history with a perf commit', () => {
    const dir = repo()
    commit(dir, 'feat: add a')
    commit(dir, 'perf: speed up b')
    commit(dir, 'fix: c')
    const result = cli(['prepare', '0.2.0', '--date', '2026-01-02'], dir)
    expect(result.status).toBe(0)
    const text = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
    expect(text).toContain('### Performance')
    expect(text).toContain('speed up b')
    expect(changelogProblems(text)).toEqual([])
  })

  it.each(['### Chores', '### Documentation', '### Misc'])('rejects the heading %s', (heading) => {
    expect(changelogProblems(content + '\n' + heading + '\n').length).toBeGreaterThan(0)
  })

  it('passes branding and contains no milestone IDs or .docs links', () => {
    expect(checkText('CHANGELOG.md', content)).toEqual([])
    expect(content).not.toMatch(/\bM\d+\b/)
    expect(content).not.toContain('.docs/')
  })
})
