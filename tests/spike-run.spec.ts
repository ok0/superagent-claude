import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkText } from '../scripts/check-branding.ts'

const RUN = fileURLToPath(new URL('../spikes/sdk/run.ts', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const K = 'sk-' + 'ant-' + 'test-AAAAAAAAAAAA'
const T = 'sk-' + 'ant-' + 'oat01-test-BBBBBBBB'
const PREFIX = 'sk-' + 'ant-'
const TEST_TIMEOUT = { timeout: 60000 }

let base = ''

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'spike-run-test-'))
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

function sandbox(name: string): { tmp: string; home: string; tmpT: string } {
  const tmp = join(base, name)
  const home = join(tmp, 'home')
  const tmpT = join(tmp, 'tmp')
  mkdirSync(home, { recursive: true })
  mkdirSync(tmpT, { recursive: true })
  return { tmp, home, tmpT }
}

function run(args: string[], env: Record<string, string | undefined>, paths: { home: string; tmpT: string }) {
  return spawnSync(process.execPath, [RUN, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: paths.home, TMPDIR: paths.tmpT, ...env },
    encoding: 'utf8',
  })
}

describe('spike:sdk runner', () => {
  it('blocks live items without credentials', TEST_TIMEOUT, () => {
    const { tmp, home, tmpT } = sandbox('no-credential')
    const doc = join(tmp, 'doc.md')
    const result = run(['--out', doc], { ISSUECREW_LIVE: '1' }, { home, tmpT })
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('ANTHROPIC_API_KEY')
    expect(result.stderr).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(result.stderr).toContain('claude setup-token')
    expect(existsSync(doc)).toBe(true)
    const text = readFileSync(doc, 'utf8')
    const blocked = text.split('\n').filter(line => line.includes('| BLOCKED(no-credential) |'))
    expect(blocked).toHaveLength(11)
    const versionRow = text.split('\n').find(line => line.startsWith('| version |'))
    expect(versionRow).toContain('| PASS |')
    expect(readdirSync(tmpT).some(name => name.startsWith('sac-spike-'))).toBe(false)
    expect(checkText('doc.md', text)).toEqual([])
  })

  it('blocks when live gate is off even with a key', TEST_TIMEOUT, () => {
    const { tmp, home, tmpT } = sandbox('gate-off')
    const doc = join(tmp, 'doc.md')
    const result = run(['--out', doc], { ANTHROPIC_API_KEY: K }, { home, tmpT })
    expect(result.status).toBe(3)
    expect(result.stdout).not.toContain(K)
    expect(result.stdout).not.toContain(PREFIX)
    expect(result.stderr).not.toContain(K)
    expect(result.stderr).not.toContain(PREFIX)
    const text = readFileSync(doc, 'utf8')
    expect(text).not.toContain(K)
    expect(text).not.toContain(PREFIX)
  })

  it('refuses ambiguous credentials', TEST_TIMEOUT, () => {
    const { tmp, home, tmpT } = sandbox('ambiguous')
    const doc = join(tmp, 'doc.md')
    const result = run(
      ['--out', doc],
      { ISSUECREW_LIVE: '1', ANTHROPIC_API_KEY: K, CLAUDE_CODE_OAUTH_TOKEN: T },
      { home, tmpT },
    )
    expect(result.status).toBe(4)
    expect(result.stderr).toContain('SPIKE_AUTH_MODE')
    expect(existsSync(doc)).toBe(false)
    const output = result.stdout + result.stderr
    expect(output).not.toContain(K)
    expect(output).not.toContain(T)
  })

  it('refuses invalid SPIKE_AUTH_MODE', TEST_TIMEOUT, () => {
    const { tmp, home, tmpT } = sandbox('bogus-mode')
    const doc = join(tmp, 'doc.md')
    const result = run(['--out', doc], { ISSUECREW_LIVE: '1', SPIKE_AUTH_MODE: 'bogus' }, { home, tmpT })
    expect(result.status).toBe(4)
    expect(existsSync(doc)).toBe(false)
  })

  it('scan detects a planted secret', TEST_TIMEOUT, () => {
    const { tmp, home, tmpT } = sandbox('scan')
    const planted = join(tmp, 'planted.md')
    const clean = join(tmp, 'clean.md')
    writeFileSync(planted, 'x ' + 'sk-' + 'ant-' + 'abc\n')
    writeFileSync(clean, 'nothing sensitive here\n')
    expect(run(['--scan', planted], {}, { home, tmpT }).status).toBe(6)
    expect(run(['--scan', clean], {}, { home, tmpT }).status).toBe(0)
  })
})
