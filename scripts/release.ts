// Release helper.
//
// Usage:
//   node scripts/release.ts verify-tag <tag>
//   node scripts/release.ts ci-gate <sha>
//   node scripts/release.ts pack-check
//   node scripts/release.ts outputs <tag>
//   node scripts/release.ts --help
//
// Exit codes: 0 pass, 1 failure (including usage errors).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/

export const CI_POLL_INTERVAL_MS = 30_000
export const CI_TIMEOUT_MS = 30 * 60_000

const USAGE = [
  'Usage: node scripts/release.ts <verify-tag <tag> | ci-gate <sha> | pack-check | outputs <tag>>',
  '',
  'Exit codes: 0 pass, 1 failure.',
  '',
].join('\n')

export function parseReleaseTag(tag: string): { version: string; prerelease: boolean } {
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(`invalid release tag "${tag}": expected vMAJOR.MINOR.PATCH with an optional -PRERELEASE suffix`)
  }
  return { version: tag.slice(1), prerelease: tag.includes('-') }
}

export function assertVersionMatch(tag: string, pkgVersion: string): void {
  const { version } = parseReleaseTag(tag)
  if (version !== pkgVersion) {
    throw new Error(`tag ${tag} does not match package.json version ${pkgVersion}`)
  }
}

export function npmDistTag(version: string): 'next' | 'latest' {
  return parseReleaseTag('v' + version).prerelease ? 'next' : 'latest'
}

export function imageTags(version: string): string[] {
  if (parseReleaseTag('v' + version).prerelease) return [version]
  const [major, minor] = version.split('.')
  return [version, `${major}.${minor}`, 'latest']
}

export type WorkflowRun = { status: string; conclusion: string | null; event: string; head_branch: string }

export function ciGate(runs: readonly WorkflowRun[]): 'pass' | 'wait' | 'fail' {
  const main = runs.filter((r) => r.event === 'push' && r.head_branch === 'main')
  if (main.some((r) => r.status === 'completed' && r.conclusion === 'success')) return 'pass'
  if (main.length > 0 && main.every((r) => r.status !== 'completed')) return 'wait'
  return 'fail'
}

export const REQUIRED_PACK_FILES = ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'lib/cli.js'] as const

export const FORBIDDEN_PACK_PREFIXES = [
  '.docs/',
  '.ensemble/',
  '.github/',
  'src/',
  'tests/',
  'spikes/',
  'scripts/',
  'deploy/',
] as const

export function checkPackFiles(paths: readonly string[]): string[] {
  const normalized = paths.map((p) => p.replace(/^\.\//, ''))
  const set = new Set(normalized)
  const violations: string[] = []
  for (const file of REQUIRED_PACK_FILES) {
    if (!set.has(file)) violations.push(`missing required file: ${file}`)
  }
  for (const path of normalized) {
    const segments = path.split('/')
    if (FORBIDDEN_PACK_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      violations.push(`forbidden path: ${path}`)
    } else if (segments.some((s) => s === '.env' || s.startsWith('.env'))) {
      violations.push(`forbidden secret file: ${path}`)
    } else if (segments.includes('fixtures')) {
      violations.push(`forbidden fixture: ${path}`)
    } else if (path.endsWith('.tgz')) {
      violations.push(`forbidden tarball: ${path}`)
    }
  }
  return violations
}

export function packFileList(cwd: string): string[] {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  })
  const parsed = JSON.parse(stdout)
  return parsed[0].files.map((f: { path: string }) => f.path)
}

export function readPackageVersion(cwd: string): string {
  return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version
}

async function runCiGate(sha: string, cwd: string): Promise<number> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    process.stderr.write(`ci-gate: invalid commit sha "${sha}"\n`)
    return 1
  }
  const started = Date.now()
  for (;;) {
    const stdout = execFileSync(
      'gh',
      ['api', `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`],
      { cwd, stdio: 'pipe', encoding: 'utf8' },
    )
    const runs: WorkflowRun[] = JSON.parse(stdout).workflow_runs.map(
      (r: { status: string; conclusion: string | null; event: string; head_branch: string }) => ({
        status: r.status,
        conclusion: r.conclusion,
        event: r.event,
        head_branch: r.head_branch,
      }),
    )
    const verdict = ciGate(runs)
    if (verdict === 'pass') {
      process.stdout.write(`ci-gate: CI passed for ${sha}\n`)
      return 0
    }
    if (verdict === 'fail') {
      process.stderr.write(`ci-gate: no successful CI run on a main push for ${sha}\n`)
      return 1
    }
    if (Date.now() - started >= CI_TIMEOUT_MS) {
      process.stderr.write(`ci-gate: timed out waiting for CI on ${sha}\n`)
      return 1
    }
    await new Promise((r) => setTimeout(r, CI_POLL_INTERVAL_MS))
  }
}

export async function main(argv: readonly string[], cwd: string = process.cwd()): Promise<number> {
  const [command, arg] = argv
  if (command === '--help') {
    process.stdout.write(USAGE)
    return 0
  }
  const usageError = (): number => {
    process.stderr.write(USAGE)
    return 1
  }
  const fail = (error: unknown): number => {
    const message = String((error as Error)?.message ?? error).split('\n')[0]
    process.stderr.write(`release: ${message}\n`)
    return 1
  }

  try {
    if (command === 'verify-tag') {
      if (arg === undefined) return usageError()
      const version = readPackageVersion(cwd)
      assertVersionMatch(arg, version)
      process.stdout.write(`tag ${arg} matches package.json version ${version}\n`)
      return 0
    }
    if (command === 'ci-gate') {
      if (arg === undefined) return usageError()
      return await runCiGate(arg, cwd)
    }
    if (command === 'pack-check') {
      const files = packFileList(cwd)
      const violations = checkPackFiles(files)
      if (violations.length === 0) {
        process.stdout.write(`pack-check: ${files.length} files, 0 violations\n`)
        return 0
      }
      process.stderr.write(`pack-check: ${violations.length} violation(s): ${violations.join('; ')}\n`)
      return 1
    }
    if (command === 'outputs') {
      if (arg === undefined) return usageError()
      const { version, prerelease } = parseReleaseTag(arg)
      process.stdout.write(
        [
          `version=${version}`,
          `dist_tag=${npmDistTag(version)}`,
          `image_tags=${imageTags(version).join(',')}`,
          `prerelease=${prerelease ? 'true' : 'false'}`,
        ].join('\n') + '\n',
      )
      return 0
    }
    return usageError()
  } catch (error) {
    return fail(error)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
