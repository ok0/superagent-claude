import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { checkMessage } from '../scripts/check-commits.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/check-commits.ts', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))

function cli(args: string[], cwd: string = ROOT) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
}

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-commits-'))
  dirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, stdio: 'pipe' },
  )
}

function commit(cwd: string, message: string): void {
  git(cwd, ['commit', '-q', '--allow-empty', '-m', message])
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('checkMessage', () => {
  it.each([
    'feat: add x',
    'fix(core): y',
    'chore!: z',
    "Merge branch 'topic' into main",
    'Revert "feat: add x"',
    'Merge ' + 'a'.repeat(40) + ' into ' + '0123456789'.repeat(4),
  ])('accepts %s', m => {
    expect(checkMessage(m)).toHaveLength(0)
  })

  it.each(['updated stuff', 'Feat add x', 'feat:', 'feat: ', '', 'Merge abc123 into def456'])('rejects %j', m => {
    expect(checkMessage(m).length).toBeGreaterThan(0)
  })

  it.each([
    'feat: add x\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    'fix: y\n\nGenerated with Claude',
    'docs: z\n\nco-authored-by: claude opus <a@b.c>',
    "Merge branch 'x'\n\nCo-Authored-By: Claude <a@b.c>",
    'Merge ' + 'a'.repeat(40) + ' into ' + 'b'.repeat(40) + '\n\nCo-Authored-By: Claude <a@b.c>',
  ])('rejects attribution %j', m => {
    expect(checkMessage(m).some(reason => reason.includes('attribution'))).toBe(true)
  })
})

describe('cli --message and --file', () => {
  it('accepts a valid message', () => {
    expect(cli(['--message', 'feat: add x']).status).toBe(0)
  })

  it('rejects an invalid message and names it on stderr', () => {
    const result = cli(['--message', 'updated stuff'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('updated stuff')
  })

  it('rejects a message with attribution', () => {
    expect(cli(['--message', 'feat: add x\n\nCo-Authored-By: Claude <a@b.c>']).status).toBe(1)
  })

  it('ignores comment lines in --file input', () => {
    const dir = tempDir()
    const file = join(dir, 'COMMIT_EDITMSG')
    writeFileSync(file, '# comment\nfeat: ok\n')
    expect(cli(['--file', file]).status).toBe(0)
  })
})

describe('cli history', () => {
  it('exits 2 outside a git repository', () => {
    const dir = tempDir()
    expect(cli([], dir).status).toBe(2)
  })

  it('reports no commits in an empty repository', () => {
    const dir = tempDir()
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: dir, stdio: 'pipe' })
    const result = cli([], dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no commits to check')
  })

  it('passes with one valid commit and fails after an invalid one is added', () => {
    const dir = tempDir()
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: dir, stdio: 'pipe' })
    commit(dir, 'feat: a')
    expect(cli([], dir).status).toBe(0)
    commit(dir, 'bad message')
    const result = cli([], dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('bad message')
  })
})
