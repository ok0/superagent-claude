import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ROOTS = ['src/', 'scripts/', 'spikes/', 'tests/']
const EXCLUDED = 'tests/live/fixtures/'
const HEADER = /^\/\/ Ported from dsh-superagent-prototype \(MIT\) /

// Each pattern is joined from pieces so this file does not match itself.
const PATTERNS: RegExp[] = [
  ['AD', 'R-[0-9]'],
  ['PA', 'C[0-9]'],
  ['\\bchar', 'ter\\b'],
  ['Port', ' note'],
  ['(Changes|Adapted) from', ' the reference'],
  ['\\b', 'M[0-9]{1,2}\\b'],
  ['(spec|char', 'ter) R[0-9]'],
].map(parts => new RegExp(parts.join('')))

const SAMPLES = [
  '// see AD' + 'R-12',
  '// PA' + 'C3',
  '// Port' + ' note: kept for now',
  '// done in M' + '41',
  '// Changes from' + ' the reference: none',
]

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', '*.ts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(path => path && ROOTS.some(root => path.startsWith(root)) && !path.startsWith(EXCLUDED))
    .filter(path => existsSync(join(ROOT, path)))
}

function violations(path: string, text: string): string[] {
  const found: string[] = []
  text.split('\n').forEach((line, index) => {
    if (HEADER.test(line)) return
    if (PATTERNS.some(pattern => pattern.test(line))) found.push(`${path}:${index + 1}: ${line.trim()}`)
  })
  return found
}

describe('process references', () => {
  it('finds none in tracked source, script, spike and test files', () => {
    const files = trackedFiles()
    expect(files).toContain('tests/process-refs.spec.ts')
    expect(files.some(file => file.startsWith('src/'))).toBe(true)
    expect(files.some(file => file.startsWith(EXCLUDED))).toBe(false)
    expect(files.flatMap(file => violations(file, readFileSync(join(ROOT, file), 'utf8')))).toEqual([])
  })

  it.each(SAMPLES)('flags the injected sample %j', sample => {
    expect(violations('sample.ts', 'const a = 1\n' + sample)).toEqual([`sample.ts:2: ${sample}`])
  })

  it('accepts the provenance header', () => {
    expect(violations('a.ts', '// Ported from dsh-superagent-prototype (MIT) docs/AD' + 'R-1.md\nconst a = 1')).toEqual(
      [],
    )
  })
})
