import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkText } from '../scripts/check-branding.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export const PUBLIC_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/pull_request_template.md',
  '.github/workflows/ci.yml',
] as const

export const REQUIRED_CONTRIBUTING = [
  '## Development setup',
  '## Tests',
  '## Checks',
  '## Commit messages',
  '## Pull requests',
  '22.19',
  'pnpm 11',
  'pnpm install --frozen-lockfile',
  '`pnpm test`',
  '`pnpm test:live`',
  'credentials',
  'CI never runs the live tests',
  'Conventional Commits',
  'No AI attribution',
  'pnpm check:all',
  'docker build -t superagent-claude:local .',
  '](CODE_OF_CONDUCT.md)',
] as const

export const REQUIRED_CONDUCT = [
  'Contributor Covenant',
  'https://www.contributor-covenant.org/version/2/1/code_of_conduct/',
  '## Reporting',
] as const

export const REQUIRED_PR_TEMPLATE = ['- [ ] `pnpm check:all`', 'Conventional Commits', 'No AI attribution'] as const

export function missingMarkers(text: string, required: readonly string[]): string[] {
  return required.filter((marker) => !text.includes(marker))
}

export function wordingProblems(path: string, text: string): string[] {
  const problems: string[] = []
  if (/\.docs\//.test(text)) problems.push('links .docs/')
  if (/\bM\d+\b/.test(text)) problems.push('milestone id')
  if (/milestone/i.test(text)) problems.push('milestone word')
  if (/[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b/i.test(text)) problems.push('email address')
  for (const violation of checkText(path, text)) {
    problems.push(`branding: line ${violation.line}`)
  }
  return problems
}

const ISSUE_ITEM_TYPES = ['markdown', 'textarea', 'input', 'dropdown', 'checkboxes']

export function issueFormProblems(text: string): string[] {
  const problems: string[] = []
  if (text.includes('\t')) problems.push('tab character')
  if (!/^name: \S/m.test(text)) problems.push('missing name')
  if (!/^description: \S/m.test(text)) problems.push('missing description')
  if (!/^body:\s*$/m.test(text)) problems.push('missing body')
  if (!/^  - type: /m.test(text)) problems.push('no body items')

  for (const match of text.matchAll(/^  - type: (\S+)/gm)) {
    const type = match[1] ?? ''
    if (!ISSUE_ITEM_TYPES.includes(type)) problems.push(`unknown type ${type}`)
  }

  const lines = text.split('\n')
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (/^  - type: /.test(line)) starts.push(index)
  })
  starts.forEach((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1] : lines.length
    const block = lines.slice(start, end).join('\n')
    const type = /^  - type: (\S+)/.exec(lines[start] ?? '')?.[1] ?? ''
    if (type === 'markdown') return
    if (!/^    id: [a-z][a-z0-9_-]*$/m.test(block)) problems.push(`item ${position + 1} has no id`)
    if (!/^    attributes:\s*$/m.test(block)) problems.push(`item ${position + 1} has no attributes`)
    if (!/^      label: \S/m.test(block)) problems.push(`item ${position + 1} has no label`)
  })

  return problems
}

export function relativeLinkProblems(file: string, text: string): string[] {
  const problems: string[] = []
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? ''
    if (/^(https?:\/\/|mailto:|#)/.test(target)) continue
    const path = target.replace(/#.*$/, '')
    if (!existsSync(join(ROOT, dirname(file), path))) problems.push(`broken link ${target}`)
  }
  return problems
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

describe('contributing docs', () => {
  const real = read('CONTRIBUTING.md')

  it('CONTRIBUTING has every required section', () => {
    expect(missingMarkers(real, REQUIRED_CONTRIBUTING)).toEqual([])
  })

  it.each(REQUIRED_CONTRIBUTING)('a CONTRIBUTING without %s is rejected', (marker) => {
    expect(missingMarkers(real.replaceAll(marker, ''), REQUIRED_CONTRIBUTING)).toContain(marker)
  })

  it('CODE_OF_CONDUCT references the Contributor Covenant and a reporting path', () => {
    expect(missingMarkers(read('CODE_OF_CONDUCT.md'), REQUIRED_CONDUCT)).toEqual([])
  })

  it('the pull request template has the checklist', () => {
    expect(missingMarkers(read('.github/pull_request_template.md'), REQUIRED_PR_TEMPLATE)).toEqual([])
  })

  it('README links CONTRIBUTING', () => {
    expect(read('README.md')).toContain('](CONTRIBUTING.md)')
  })

  it.each(PUBLIC_FILES)('%s passes the public wording rules', (path) => {
    expect(existsSync(join(ROOT, path))).toBe(true)
    expect(wordingProblems(path, read(path))).toEqual([])
  })

  it.each([
    ['see .docs/notes.md', 'links .docs/'],
    ['shipped in M28', 'milestone id'],
    ['next Milestone', 'milestone word'],
    ['mail dev@example.com', 'email address'],
    ['built with Claude' + ' Code', 'branding'],
  ])('wording sample %j is rejected', (sample, reason) => {
    const problems = wordingProblems('CONTRIBUTING.md', sample)
    expect(problems.some((problem) => problem.includes(reason))).toBe(true)
  })

  it.each(['bug_report.yml', 'feature_request.yml'])('%s is a valid issue form', (file) => {
    expect(issueFormProblems(read(`.github/ISSUE_TEMPLATE/${file}`))).toEqual([])
  })

  describe('issue form violations', () => {
    const bug = read('.github/ISSUE_TEMPLATE/bug_report.yml')
    const violations: [string, string][] = [
      ['name line removed', bug.replace(/^name: .*\n/m, '')],
      ['body replaced by items', bug.replace(/^body:/m, 'items:')],
      ['bogus item type', bug.replace('  - type: textarea', '  - type: bogus')],
      ['tab indent', bug.replace('\n  ', '\n\t')],
      ['first id removed', bug.replace(/^    id: .*\n/m, '')],
    ]
    it.each(violations)('%s is rejected', (_name, text) => {
      expect(issueFormProblems(text).length).toBeGreaterThan(0)
    })
  })

  it.each(['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', '.github/pull_request_template.md'])(
    'relative links in %s resolve',
    (file) => {
      expect(relativeLinkProblems(file, read(file))).toEqual([])
    },
  )
})
