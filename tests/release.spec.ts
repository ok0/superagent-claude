import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  FORBIDDEN_PACK_PREFIXES,
  REQUIRED_PACK_FILES,
  assertVersionMatch,
  checkPackFiles,
  ciGate,
  imageTags,
  npmDistTag,
  packFileList,
  parseReleaseTag,
  type WorkflowRun,
} from '../scripts/release.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../scripts/release.ts', import.meta.url))

function cli(args: string[], cwd: string = ROOT) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
}

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

let packed: string[] = []

beforeAll(() => {
  if (!existsSync(join(ROOT, 'lib/cli.js'))) {
    execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'pipe' })
  }
  packed = packFileList(ROOT)
}, 180_000)

describe('parseReleaseTag', () => {
  it('parses stable and prerelease tags', () => {
    expect(parseReleaseTag('v0.1.0')).toEqual({ version: '0.1.0', prerelease: false })
    expect(parseReleaseTag('v0.1.0-rc.1')).toEqual({ version: '0.1.0-rc.1', prerelease: true })
  })

  it.each(['0.1.0', 'v1.2', 'v01.2.3', 'v1.2.3+b'])('rejects %s', tag => {
    expect(() => parseReleaseTag(tag)).toThrow()
  })
})

describe('assertVersionMatch', () => {
  it('rejects a mismatched version', () => {
    expect(() => assertVersionMatch('v0.1.1', '0.1.0')).toThrow()
  })

  it('accepts matching stable and prerelease versions', () => {
    expect(() => assertVersionMatch('v0.1.0', '0.1.0')).not.toThrow()
    expect(() => assertVersionMatch('v0.1.0-rc.1', '0.1.0-rc.1')).not.toThrow()
  })
})

describe('npmDistTag and imageTags', () => {
  it('maps stable and prerelease versions to dist tags', () => {
    expect(npmDistTag('0.1.0')).toBe('latest')
    expect(npmDistTag('0.1.0-rc.1')).toBe('next')
  })

  it('maps versions to image tags', () => {
    expect(imageTags('0.1.0')).toEqual(['0.1.0', '0.1', 'latest'])
    expect(imageTags('0.1.0-rc.1')).toEqual(['0.1.0-rc.1'])
  })
})

describe('ciGate', () => {
  const run = (status: string, conclusion: string | null, event = 'push', head_branch = 'main'): WorkflowRun => ({
    status,
    conclusion,
    event,
    head_branch,
  })

  it('passes when a main push run succeeded', () => {
    expect(ciGate([run('completed', 'success')])).toBe('pass')
    expect(ciGate([run('completed', 'failure'), run('completed', 'success')])).toBe('pass')
  })

  it('waits while every main push run is incomplete', () => {
    expect(ciGate([run('in_progress', null)])).toBe('wait')
    expect(ciGate([run('queued', null)])).toBe('wait')
  })

  it('fails otherwise', () => {
    expect(ciGate([run('completed', 'failure')])).toBe('fail')
    expect(ciGate([run('completed', 'success', 'pull_request', 'feature')])).toBe('fail')
    expect(ciGate([run('in_progress', null, 'pull_request', 'feature')])).toBe('fail')
    expect(ciGate([])).toBe('fail')
  })
})

describe('checkPackFiles', () => {
  it('is clean for the real npm pack file list', () => {
    expect(checkPackFiles(packed)).toEqual([])
    for (const file of ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'lib/cli.js']) {
      expect(packed).toContain(file)
    }
    for (const path of packed) {
      expect(FORBIDDEN_PACK_PREFIXES.some(prefix => path.startsWith(prefix))).toBe(false)
      expect(path).not.toContain('.env')
      expect(path).not.toContain('fixtures')
      expect(path.endsWith('.tgz')).toBe(false)
    }
  })

  it.each(['tests/x.spec.ts', '.docs/a.md', '.env'])('flags %s', p => {
    const violations = checkPackFiles([...packed, p])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain(p)
  })

  it('reports a missing required file', () => {
    expect(checkPackFiles(packed.filter(p => p !== 'NOTICE'))).toEqual(['missing required file: NOTICE'])
  })

  it('lists every required file', () => {
    expect(REQUIRED_PACK_FILES).toContain('lib/cli.js')
  })
})

describe('cli', () => {
  it('verify-tag passes on a matching tag and fails on a mismatch or bad format', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }))

    expect(cli(['verify-tag', 'v0.1.0'], dir).status).toBe(0)

    const mismatch = cli(['verify-tag', 'v0.1.1'], dir)
    expect(mismatch.status).toBe(1)
    const mismatchErr = mismatch.stderr.trim()
    expect(mismatchErr).not.toContain('\n')
    expect(mismatchErr).toContain('does not match')

    const badFormat = cli(['verify-tag', '0.1.0'], dir)
    expect(badFormat.status).toBe(1)
    const badErr = badFormat.stderr.trim()
    expect(badErr).not.toContain('\n')
    expect(badErr).toContain('invalid release tag')
  })

  it('outputs prints release metadata for a prerelease tag', () => {
    const result = cli(['outputs', 'v0.1.0-rc.1'])
    expect(result.status).toBe(0)
    const lines = result.stdout.split('\n').filter(l => l !== '')
    expect(lines).toContain('dist_tag=next')
    expect(lines).toContain('image_tags=0.1.0-rc.1')
    expect(lines).toContain('prerelease=true')
    for (const line of lines) {
      expect(line).toMatch(/^[a-z_]+=\S*$/)
    }
  })

  it('outputs prints release metadata for a stable tag', () => {
    const result = cli(['outputs', 'v0.1.0'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('image_tags=0.1.0,0.1,latest')
    expect(result.stdout).toContain('dist_tag=latest')
    expect(result.stdout).toContain('prerelease=false')
  })

  it('pack-check passes on the repository', () => {
    const result = cli(['pack-check'])
    expect(result.status).toBe(0)
  }, 60_000)

  it('exits 1 without a subcommand and 0 for --help', () => {
    expect(cli([]).status).toBe(1)
    expect(cli(['--help']).status).toBe(0)
  })
})

describe('package.json metadata', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  it('declares repository, homepage, bugs, and publish access', () => {
    expect(pkg.repository.url).toBe('git+https://github.com/ok0/superagent-claude.git')
    expect(pkg.publishConfig.access).toBe('public')
    expect(typeof pkg.homepage).toBe('string')
    expect(pkg.homepage).toMatch(/^https:\/\/github\.com\/ok0\/superagent-claude/)
    expect(typeof pkg.bugs.url).toBe('string')
    expect(pkg.bugs.url).toMatch(/^https:\/\/github\.com\/ok0\/superagent-claude/)
  })

  it('declares the release scripts', () => {
    expect(pkg.scripts['release:prepare']).toBe('node scripts/changelog.ts prepare')
    expect(pkg.scripts['release:check']).toBe('node scripts/release.ts')
  })

  it('keeps files and dependencies unchanged', () => {
    expect(pkg.files).toEqual(['lib', 'prompts', 'skills', 'LICENSE', 'NOTICE', 'README.md'])
    expect(Object.keys(pkg.dependencies)).toEqual([
      '@anthropic-ai/claude-agent-sdk',
      '@octokit/core',
      'proper-lockfile',
      'zod',
    ])
    expect(pkg.dependencies['@octokit/core']).toMatch(/^\d+\.\d+\.\d+$/)
    expect(Object.keys(pkg.dependencies).filter(k => k.startsWith('@octokit/'))).toEqual(['@octokit/core'])
    expect(Object.keys(pkg.devDependencies)).toEqual(['@types/node', 'prettier', 'tsdown', 'typescript', 'vitest'])
  })
})
