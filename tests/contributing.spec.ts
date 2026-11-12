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
  'SECURITY.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/pull_request_template.md',
  '.github/workflows/ci.yml',
  'docs/releasing.md',
  'docs/deploy.md',
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
  '`pnpm format`',
  'docker build -t superagent-claude:local .',
  '](CODE_OF_CONDUCT.md)',
  '## Run live tests against your own playground',
  '`SUPERAGENT_CLAUDE_LIVE_REPO`',
  '`SUPERAGENT_CLAUDE_LIVE_OWNER_LOGIN`',
  '`SUPERAGENT_CLAUDE_LIVE_AGENT_LOGIN`',
  '`SUPERAGENT_CLAUDE_LIVE_REPORT_REPO`',
  'your-name/your-playground',
  '`pnpm live:seed`',
  '`pnpm live:cleanup`',
  '](docs/releasing.md)',
  'Code comments say why, not what',
  'internal planning IDs',
] as const

export const REQUIRED_RELEASING = [
  'Semantic Versioning',
  '`vMAJOR.MINOR.PATCH`',
  'a breaking change bumps MINOR',
  'under the `next` dist-tag',
  'under `latest`',
  'pnpm release:prepare <version>',
  'chore(release): <version>',
  'Recommended, not enforced',
  'pnpm test:live',
  'git push origin main',
  'git tag -a v<version> -m v<version>',
  'git push origin v<version>',
  '**Settings**',
  '**Trusted Publisher**',
  '**GitHub Actions**',
  'Organization or user: `ok0`',
  'Repository: `superagent-claude`',
  'Workflow filename: `release.yml`',
  'Environment name: leave it empty',
  'within 2 days',
  'right before you push the tag',
  '11.5.1',
  'with provenance',
  'reads no repository secrets',
  'next patch version',
  '`publish (oidc)`',
  'docker login ghcr.io',
  '**Change visibility**',
  'org.opencontainers.image.source',
  'nothing is published',
  'npm view superagent-claude',
  'gh release view v<version>',
  'docker pull ghcr.io/ok0/superagent-claude:',
  '10001:10001',
  'npm dist-tag add superagent-claude@<version> <tag>',
  '**Re-run failed jobs**',
  'The interface may change',
] as const

export const RELEASING_ORDER = [
  '## Versions',
  '## Prepare the release',
  '## Run the live tests',
  '## Push to main and wait for CI',
  '## Tag and push',
  '## What the release workflow does',
  '## Check the release',
  '## Recovery',
] as const

export const FORBIDDEN_RELEASING = /bootstrap|NPM_TOKEN|E404|bypass|Manage Actions access/i

export function numberedItems(text: string, heading: string): number {
  const start = text.indexOf(heading)
  const rest = text.slice(start + heading.length)
  const next = rest.search(/^#{2,3} /m)
  const section = next === -1 ? rest : rest.slice(0, next)
  return section.split('\n').filter(line => /^\d+\. /.test(line)).length
}

export const REQUIRED_CONDUCT = [
  'Contributor Covenant',
  'https://www.contributor-covenant.org/version/2/1/code_of_conduct/',
  '## Reporting',
] as const

export const REQUIRED_SECURITY = [
  'https://github.com/ok0/superagent-claude/security/advisories/new',
  'public issue',
] as const

export const REQUIRED_PR_TEMPLATE = ['- [ ] `pnpm check:all`', 'Conventional Commits', 'No AI attribution'] as const

export function missingMarkers(text: string, required: readonly string[]): string[] {
  return required.filter(marker => !text.includes(marker))
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

  it.each(REQUIRED_CONTRIBUTING)('a CONTRIBUTING without %s is rejected', marker => {
    expect(missingMarkers(real.replaceAll(marker, ''), REQUIRED_CONTRIBUTING)).toContain(marker)
  })

  it('the releasing guide has every marker', () => {
    expect(missingMarkers(read('docs/releasing.md'), REQUIRED_RELEASING)).toEqual([])
  })

  it.each(REQUIRED_RELEASING)('a releasing guide without %s is rejected', marker => {
    const text = read('docs/releasing.md')
    expect(missingMarkers(text.replaceAll(marker, ''), REQUIRED_RELEASING)).toContain(marker)
  })

  it('the releasing guide sections are in order', () => {
    const text = read('docs/releasing.md')
    const positions = RELEASING_ORDER.map(heading => text.indexOf('\n' + heading + '\n'))
    positions.forEach(position => expect(position).toBeGreaterThan(-1))
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] ?? -1)
    }
  })

  it('the trusted publisher steps are a numbered list', () => {
    expect(numberedItems(read('docs/releasing.md'), '### npm trusted publisher')).toBe(8)
  })

  it('the releasing guide has no token or bootstrap path', () => {
    expect(read('docs/releasing.md')).not.toMatch(FORBIDDEN_RELEASING)
  })

  it.each(['Set NPM_TOKEN first', 'the Bootstrap token', 'PUT E404', 'bypass 2FA', 'Manage Actions access'])(
    'releasing sample %j is rejected',
    sample => {
      expect(sample).toMatch(FORBIDDEN_RELEASING)
    },
  )

  it('CONTRIBUTING links the releasing guide on exactly one line', () => {
    const lines = real.split('\n').filter(line => line.includes('](docs/releasing.md)'))
    expect(lines.length).toBe(1)
  })

  it('CODE_OF_CONDUCT references the Contributor Covenant and a reporting path', () => {
    expect(missingMarkers(read('CODE_OF_CONDUCT.md'), REQUIRED_CONDUCT)).toEqual([])
  })

  it('SECURITY names private vulnerability reporting and links the trust policy', () => {
    const security = read('SECURITY.md')
    expect(missingMarkers(security, REQUIRED_SECURITY)).toEqual([])
    expect(security).toContain('](docs/security.md)')
  })

  it.each(REQUIRED_SECURITY)('a SECURITY without %s is rejected', marker => {
    expect(missingMarkers(read('SECURITY.md').replaceAll(marker, ''), REQUIRED_SECURITY)).toContain(marker)
  })

  it('the pull request template has the checklist', () => {
    expect(missingMarkers(read('.github/pull_request_template.md'), REQUIRED_PR_TEMPLATE)).toEqual([])
  })

  it('README links CONTRIBUTING', () => {
    expect(read('README.md')).toContain('](CONTRIBUTING.md)')
  })

  it('README test repositories section names only the allowed playground example', () => {
    const allowedExample =
      "The project's own live runs use [ok0/superagent-claude-playground](https://github.com/ok0/superagent-claude-playground) as the playground."
    const readme = read('README.md')
    const start = readme.indexOf('## Test repositories')
    const end = readme.indexOf('\n## ', start + 1)
    const section = readme.slice(start, end === -1 ? undefined : end)
    expect(section.split(allowedExample).length - 1).toBeLessThanOrEqual(1)
    const rest = section.replaceAll(allowedExample, '')
    expect(rest).not.toMatch(/superagent-claude-playground/)
    expect(rest).not.toMatch(/\bok0\b/)
    expect(section).toContain('SUPERAGENT_CLAUDE_LIVE_REPO')
    expect(section).toContain('](CONTRIBUTING.md#run-live-tests-against-your-own-playground)')
  })

  it.each(PUBLIC_FILES)('%s passes the public wording rules', path => {
    expect(existsSync(join(ROOT, path))).toBe(true)
    expect(wordingProblems(path, read(path))).toEqual([])
  })

  it.each([
    ['see .docs/notes.md', 'links .docs/'],
    ['shipped in M' + '28', 'milestone id'],
    ['next Milestone', 'milestone word'],
    ['mail dev@example.com', 'email address'],
    ['built with Claude' + ' Code', 'branding'],
  ])('wording sample %j is rejected', (sample, reason) => {
    const problems = wordingProblems('CONTRIBUTING.md', sample)
    expect(problems.some(problem => problem.includes(reason))).toBe(true)
  })

  it.each(['bug_report.yml', 'feature_request.yml'])('%s is a valid issue form', file => {
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

  it.each([
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    '.github/pull_request_template.md',
    'SECURITY.md',
    'docs/releasing.md',
  ])('relative links in %s resolve', file => {
    expect(relativeLinkProblems(file, read(file))).toEqual([])
  })
})
