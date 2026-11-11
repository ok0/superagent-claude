// Changelog section generator and release notes extractor.
//
// Usage:
//   node scripts/changelog.ts prepare <version> [--date YYYY-MM-DD]
//   node scripts/changelog.ts notes <version>
//   node scripts/changelog.ts --help
//
// `prepare` sets package.json version and inserts a CHANGELOG.md section built from the
// Conventional Commits since the previous tag. It never tags or commits.
// `notes` prints the CHANGELOG.md body of one version.
// Exit codes: 0 success, 1 failure (including usage errors).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ATTRIBUTION_PATTERNS, AUTO_HEADER_PATTERN } from './check-commits.ts'
import { isAiAttributionLine } from '../src/infra/text.ts'

export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/

export type ChangelogCommit = { sha: string; message: string }

const ENTRY_HEADER = /^([a-z]+)(?:\(([^()\r\n]+)\))?(!)?: (\S.*)$/
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: /m
const MILESTONE_ID = /\bM\d+\b/
const MILESTONE_WORD = /milestone/i

export const CATEGORIES = [
  ['breaking', 'Breaking changes'],
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
] as const

type Category = (typeof CATEGORIES)[number][0]

const USAGE = [
  'Usage: node scripts/changelog.ts prepare <version> [--date YYYY-MM-DD] | notes <version>',
  '',
  'prepare sets package.json version and inserts the CHANGELOG.md section (no tag or commit is created).',
  'notes prints the CHANGELOG.md body of one version.',
  'Exit codes: 0 success, 1 failure.',
  '',
].join('\n')

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' })
}

function headerOf(message: string): string | undefined {
  const line = message.split(/\r?\n/).find((l) => l.trim() !== '')
  return line?.trimEnd()
}

export function renderSection(version: string, date: string, commits: readonly ChangelogCommit[]): string {
  const entries: Record<Category, string[]> = { breaking: [], feat: [], fix: [], perf: [] }
  const reasons: string[] = []
  for (const { sha, message } of commits) {
    const header = headerOf(message)
    if (header === undefined || AUTO_HEADER_PATTERN.test(header)) continue
    const match = ENTRY_HEADER.exec(header)
    if (match === null) continue
    const [, type, scope, bang, subject] = match
    const sha7 = sha.slice(0, 7)
    let key: Category
    if (bang !== undefined || BREAKING_FOOTER.test(message)) {
      key = 'breaking'
    } else if (type === 'feat' || type === 'fix' || type === 'perf') {
      key = type
    } else {
      continue
    }
    const entry = scope !== undefined ? `- ${scope}: ${subject} (${sha7})` : `- ${subject} (${sha7})`
    entries[key].push(entry)
    if (MILESTONE_ID.test(entry)) reasons.push(`${sha7}: contains a milestone ID: "${header}"`)
    if (MILESTONE_WORD.test(entry)) reasons.push(`${sha7}: mentions "milestone": "${header}"`)
    const attribution = message
      .split(/\r?\n/)
      .find((line) => isAiAttributionLine(line) || ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(line)))
    if (attribution !== undefined) reasons.push(`${sha7}: contains AI authorship attribution: "${attribution.trim()}"`)
  }
  if (reasons.length > 0) {
    throw new Error('changelog blocked:\n' + reasons.map((r) => '  - ' + r).join('\n'))
  }
  let out = `## [${version}] - ${date}\n`
  for (const [key, title] of CATEGORIES) {
    const list = entries[key]
    if (list.length === 0) continue
    out += `\n### ${title}\n\n${list.join('\n')}\n`
  }
  return out
}

export function previousTag(version: string, cwd: string): string | undefined {
  const args = ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--exclude', `v${version}`]
  if (!version.includes('-')) args.push('--exclude', 'v*-*')
  try {
    return git(args, cwd).trim()
  } catch {
    return undefined
  }
}

export function collectCommits(version: string, cwd: string): ChangelogCommit[] {
  try {
    git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)
  } catch {
    return []
  }
  const base = previousTag(version, cwd)
  const output = git(['log', '--format=%H%x1f%B%x1e', base === undefined ? 'HEAD' : `${base}..HEAD`], cwd)
  return output
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const sep = entry.indexOf('\x1f')
      return { sha: entry.slice(0, sep), message: entry.slice(sep + 1) }
    })
}

export function insertSection(changelog: string, version: string, section: string): string {
  const lines = changelog.split('\n')
  if (lines.some((line) => line.startsWith(`## [${version}]`))) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`)
  }
  const idx = lines.findIndex((line) => line.startsWith('## ['))
  let result: string
  if (idx === -1) {
    result = changelog.trimEnd() + '\n\n' + section
  } else {
    const before = lines.slice(0, idx).join('\n').trimEnd()
    const parts = before === '' ? [] : [before]
    result = [...parts, section.trimEnd(), '', ...lines.slice(idx)].join('\n')
  }
  return result.replace(/\n*$/, '\n')
}

export function extractNotes(changelog: string, version: string): string {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start === -1) throw new Error(`no CHANGELOG.md section for ${version}`)
  let end = lines.findIndex((line, i) => i > start && line.startsWith('## ['))
  if (end === -1) end = lines.length
  const body = lines.slice(start + 1, end)
  while (body.length > 0 && (body[0] ?? '').trim() === '') body.shift()
  while (body.length > 0 && (body.at(-1) ?? '').trim() === '') body.pop()
  return body.join('\n')
}

function prepare(args: readonly string[], cwd: string): number {
  const [version, ...flags] = args
  if (version === undefined) {
    process.stderr.write(USAGE)
    return 1
  }
  let date = new Date().toISOString().slice(0, 10)
  for (let i = 0; i < flags.length; i++) {
    const value = flags[i + 1]
    if (flags[i] !== '--date' || value === undefined) {
      process.stderr.write(USAGE)
      return 1
    }
    date = value
    i++
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`invalid version "${version}": expected MAJOR.MINOR.PATCH[-PRERELEASE]`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid date "${date}": expected YYYY-MM-DD`)
  }
  for (const name of ['CHANGELOG.md', 'package.json']) {
    if (!existsSync(join(cwd, name))) throw new Error(`missing ${name} in ${cwd}`)
  }
  const changelogPath = join(cwd, 'CHANGELOG.md')
  const packagePath = join(cwd, 'package.json')
  const section = renderSection(version, date, collectCommits(version, cwd))
  const next = insertSection(readFileSync(changelogPath, 'utf8'), version, section)
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  pkg.version = version
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n')
  writeFileSync(changelogPath, next)
  process.stdout.write(`prepared ${version}: package.json and CHANGELOG.md updated (no tag or commit created)\n`)
  return 0
}

function notes(args: readonly string[], cwd: string): number {
  const [version, ...rest] = args
  if (version === undefined || rest.length > 0) {
    process.stderr.write(USAGE)
    return 1
  }
  const changelogPath = join(cwd, 'CHANGELOG.md')
  if (!existsSync(changelogPath)) throw new Error(`missing CHANGELOG.md in ${cwd}`)
  process.stdout.write(extractNotes(readFileSync(changelogPath, 'utf8'), version) + '\n')
  return 0
}

export function main(argv: readonly string[], cwd: string = process.cwd()): number {
  const [command, ...args] = argv
  if (command === '--help') {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    if (command === 'prepare') return prepare(args, cwd)
    if (command === 'notes') return notes(args, cwd)
  } catch (error) {
    process.stderr.write(`changelog: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  process.stderr.write(USAGE)
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
