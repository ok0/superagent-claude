// Branding check: the CLI product name must not be used as a product name.
//
// Rule: the two-word CLI product name (the word "Claude", one space, then the word "Code")
// must not appear in repository files. Permitted wording: "Claude Agent", "Powered by Claude".
// Exceptions are declared only in BRANDING_RULES below.
// Known limitation: matching is line by line, so a name split across a line break is not detected.
//
// Usage:
//   pnpm check:branding [files...]
//   Without arguments, every tracked and untracked (non-ignored) file in the repository is checked.
// Exit codes: 0 pass, 1 violation, 2 usage or environment error.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const FORBIDDEN_PATTERN = /\bclaude[ \t]+code\b/i

export const BRANDING_RULES = {
  excludedPathPrefixes: ['.ensemble/', '.r/', 'tests/fixtures/branding/'],
  allowedPatterns: [/CLAUDE_CODE_[A-Z0-9_]*/g, /@anthropic-ai\/claude-[a-z0-9-]+/gi, /claude-code/gi],
  allowLineMarker: 'branding:allow',
} as const

export type Violation = { path: string; line: number; text: string }

export function isExcluded(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return BRANDING_RULES.excludedPathPrefixes.some(prefix => normalized.startsWith(prefix))
}

export function checkText(path: string, content: string): Violation[] {
  const violations: Violation[] = []
  const lines = content.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.includes(BRANDING_RULES.allowLineMarker)) return
    let stripped = line
    for (const pattern of BRANDING_RULES.allowedPatterns) {
      stripped = stripped.replace(pattern, '')
    }
    if (FORBIDDEN_PATTERN.test(stripped)) {
      violations.push({ path, line: index + 1, text: line.trim() })
    }
  })
  return violations
}

export function listRepositoryFiles(cwd: string): { root: string; files: string[] } {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim()
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  })
  const files = output.split('\0').filter(file => file !== '' && !isExcluded(file))
  return { root, files }
}

export function main(argv: readonly string[], cwd: string = process.cwd()): number {
  let items: { label: string; abs: string }[]
  if (argv.length > 0) {
    items = argv.map(arg => ({ label: arg, abs: resolve(cwd, arg) }))
  } else {
    let listing: { root: string; files: string[] }
    try {
      listing = listRepositoryFiles(cwd)
    } catch {
      process.stderr.write(`not a git repository: ${cwd}\n`)
      return 2
    }
    items = listing.files.map(file => ({ label: file, abs: resolve(listing.root, file) }))
  }

  let checked = 0
  let violationCount = 0
  for (const item of items) {
    if (!existsSync(item.abs)) continue
    const buffer = readFileSync(item.abs)
    if (buffer.subarray(0, 8000).includes(0)) continue
    checked++
    const found = checkText(item.label, buffer.toString('utf8'))
    for (const violation of found) {
      process.stderr.write(`${violation.path}:${violation.line}: ${violation.text}\n`)
    }
    violationCount += found.length
  }
  if (violationCount > 0) {
    process.stderr.write(
      'the CLI product name must not be used as a product name; write "Claude Agent" or "Powered by Claude"\n',
    )
  }
  process.stdout.write(`checked ${checked} file(s), ${violationCount} violation(s)\n`)
  return violationCount > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
