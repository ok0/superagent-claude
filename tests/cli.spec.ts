import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { run } from '../src/cli/main.ts'

const pkg = JSON.parse(readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'package.json'), 'utf8')) as {
  version: string
}

function collect() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    write: (s: string) => out.push(s),
    fail: (s: string) => err.push(s),
  }
}

describe('cli', () => {
  it('prints version', () => {
    const c = collect()
    const code = run(['--version'], c.write, c.fail)
    expect(code).toBe(0)
    expect(c.out.join('')).toBe(`superagent-claude ${pkg.version}\n`)
  })

  it('prints help with no arguments', () => {
    const c = collect()
    const code = run([], c.write, c.fail)
    expect(code).toBe(0)
    expect(c.out.join('')).toContain('Usage: superagent-claude')
  })

  it('rejects unknown argument', () => {
    const c = collect()
    const code = run(['bogus'], c.write, c.fail)
    expect(code).toBe(1)
    expect(c.err.join('')).toContain("unknown argument 'bogus'")
  })
})
