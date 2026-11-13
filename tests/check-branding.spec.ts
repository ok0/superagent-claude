import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkText, isExcluded } from '../scripts/check-branding.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/check-branding.ts', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIX = join(ROOT, 'tests/fixtures/branding')

function cli(args: string[], cwd: string = ROOT) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
}

describe('check-branding', () => {
  it('rejects the product-name fixture', () => {
    const violations = checkText('violating.md', readFileSync(join(FIX, 'violating.md'), 'utf8'))
    expect(violations).toHaveLength(2)
    const result = cli([join(FIX, 'violating.md')])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('violating.md:2:')
  })

  it('accepts the allowed fixture', () => {
    const violations = checkText('allowed.md', readFileSync(join(FIX, 'allowed.md'), 'utf8'))
    expect(violations).toHaveLength(0)
    expect(cli([join(FIX, 'allowed.md')]).status).toBe(0)
  })

  it('detects a runtime-built product name and allows the environment variable', () => {
    expect(checkText('x.md', 'Built with ' + 'Claude' + '\tCode')).toHaveLength(1)
    expect(checkText('x.md', 'CLAUDE_CODE_OAUTH_TOKEN')).toHaveLength(0)
  })

  it('allows naming where a tool runs, not the name as a product', () => {
    expect(checkText('x.svg', 'Describe one change in ' + 'Claude' + ' Code')).toHaveLength(0)
    expect(checkText('x.md', 'Built with ' + 'Claude' + ' Code in a sandbox')).toHaveLength(1)
  })

  it('excludes the configured paths only', () => {
    expect(isExcluded('.r/a.md')).toBe(true)
    expect(isExcluded('.ensemble/b.md')).toBe(true)
    expect(isExcluded('tests/fixtures/branding/violating.md')).toBe(true)
    expect(isExcluded('README.md')).toBe(false)
  })

  it('passes for the whole repository', () => {
    expect(cli([], ROOT).status).toBe(0)
  })
})
