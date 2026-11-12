import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCS = [...readdirSync(join(ROOT, 'docs')).map(name => `docs/${name}`), 'README.md'].filter(name =>
  name.endsWith('.md'),
)

const slug = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-')

function headings(md: string): Set<string> {
  const found = new Set<string>()
  const counts = new Map<string, number>()
  let fence = false
  for (const line of md.split('\n')) {
    if (line.startsWith('```') || line.startsWith('~~~')) {
      fence = !fence
      continue
    }
    if (fence) continue
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const base = slug(match[1]!)
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    found.add(count === 0 ? base : `${base}-${count}`)
  }
  return found
}

function anchorProblems(root: string, files: string[]): { checked: string[]; broken: string[] } {
  const checked: string[] = []
  const broken: string[] = []
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const match of text.matchAll(/\]\(([^)\s#:]+\.md)#([^)\s]+)\)/g)) {
      const target = match[1]!
      const anchor = match[2]!
      const entry = `${file} -> ${target}#${anchor}`
      checked.push(entry)
      const path = join(dirname(join(root, file)), target)
      let present: Set<string> | undefined
      try {
        present = headings(readFileSync(path, 'utf8'))
      } catch {
        present = undefined
      }
      if (!present || !present.has(anchor)) broken.push(entry)
    }
  }
  return { checked, broken }
}

describe('markdown anchor links', () => {
  let tmp: string | undefined

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
    tmp = undefined
  })

  it('every relative markdown anchor link in docs and README resolves', () => {
    const { checked, broken } = anchorProblems(ROOT, DOCS)
    expect(broken).toEqual([])
    expect(checked).toContain('docs/deploy.md -> configuration.md#environment-notes')
  })

  it('a missing anchor is reported', () => {
    tmp = mkdtempSync(join(tmpdir(), 'docs-links-'))
    mkdirSync(join(tmp, 'docs'))
    writeFileSync(join(tmp, 'docs', 'a.md'), '[x](b.md#missing) and [y](b.md#present-heading)\n')
    writeFileSync(join(tmp, 'docs', 'b.md'), '# Title\n\n## Present heading\n')
    expect(anchorProblems(tmp, ['docs/a.md']).broken).toEqual(['docs/a.md -> b.md#missing'])
  })

  it('configuration.md documents environment notes', () => {
    const lines = readFileSync(join(ROOT, 'docs', 'configuration.md'), 'utf8').split('\n')
    const start = lines.indexOf('## Environment notes')
    expect(start).toBeGreaterThanOrEqual(0)
    let end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
    if (end < 0) end = lines.length
    const section = lines.slice(start, end).join('\n')
    for (const phrase of [
      '`prompts/environment/<owner>/<name>.md`',
      '4000 characters',
      'only for tickets on that repository',
      'case-insensitively',
      'at startup',
      'On reload',
      'previous note stays',
      'ignored with a warning',
      'Do not put tokens, passwords, or other secrets',
    ]) {
      expect(section).toContain(phrase)
    }
    const whole = readFileSync(join(ROOT, 'docs', 'configuration.md'), 'utf8')
    expect(whole).not.toMatch(/\.docs\//)
    expect(whole).not.toMatch(/\bM\d{1,3}\b/)
  })
})
