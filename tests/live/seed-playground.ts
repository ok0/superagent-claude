import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ghJson, tokenScopes, type Runner } from './gh.ts'
import { assertAllowedRepo } from './guard.ts'
import { assertClean, blobSha, commitProblems, preflight, seedPlan, WORKFLOW_PATH, type SeedFile } from './rules.ts'

export const PLAYGROUND = assertAllowedRepo('ok0/superagent-claude-playground')

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'playground-seed')
const WORKFLOW_FIXTURE = join(import.meta.dirname, 'fixtures', 'playground-ci.yml')

function walk(dir: string, prefix: string): SeedFile[] {
  const files: SeedFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full, rel))
    else if (entry.isFile()) files.push({ path: rel, content: readFileSync(full, 'utf8') })
  }
  return files
}

export function loadSeed(withCi: boolean): SeedFile[] {
  const files = walk(FIXTURE_DIR, '')
  if (withCi) files.push({ path: WORKFLOW_PATH, content: readFileSync(WORKFLOW_FIXTURE, 'utf8') })
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export interface SeedOptions {
  token: string
  withoutCi: boolean
  run?: Runner
  out: (line: string) => void
  recordDir?: string
  pollMs?: number
  ciTimeoutMs?: number
}

interface SeedRecord {
  repo: string
  status: string
  ci: string
  missing: string[]
  actions: string[]
  head?: string
  commit?: string
  files?: number
  problems?: string[]
}

interface RemoteBlobEntry { path: string; type: string; sha: string }
interface CiRuns { workflow_runs?: { status: string; conclusion: string | null }[] }

function writeRecord(o: SeedOptions, record: SeedRecord): void {
  if (!o.recordDir) return
  mkdirSync(o.recordDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(join(o.recordDir, 'seed-' + stamp + '.json'), JSON.stringify(record, null, 2) + '\n')
}

async function reportCi(o: SeedOptions, sha: string): Promise<{ verdict: 'success' | 'failure' | 'timeout'; runs: number }> {
  const pollMs = o.pollMs ?? 15_000
  const deadline = Date.now() + (o.ciTimeoutMs ?? 900_000)
  for (;;) {
    const body = await ghJson<CiRuns>(o.token, ['repos/' + PLAYGROUND + '/actions/runs?head_sha=' + sha + '&per_page=20'], { run: o.run })
    const runs = body.workflow_runs ?? []
    if (runs.length > 0 && runs.every(run => run.status === 'completed')) {
      return { verdict: runs.every(run => run.conclusion === 'success') ? 'success' : 'failure', runs: runs.length }
    }
    if (Date.now() >= deadline) return { verdict: 'timeout', runs: runs.length }
    await new Promise(resolveSleep => setTimeout(resolveSleep, pollMs))
  }
}

export async function runSeed(o: SeedOptions): Promise<number> {
  const P = PLAYGROUND
  const run = o.run
  const scopes = await tokenScopes(o.token, { run })
  const permissions = await ghJson<{ enabled?: boolean }>(o.token, ['repos/' + P + '/actions/permissions'], { run })
  const pf = preflight({ scopes, actionsEnabled: permissions.enabled === true })
  const pfActions = pf.status === 'BLOCKED' ? pf.actions : []
  const pfMissing: string[] = pf.status === 'BLOCKED' ? pf.missing : []

  if (pf.status === 'BLOCKED' && !o.withoutCi) {
    o.out('STATUS: BLOCKED')
    for (const m of pfMissing) o.out('missing: ' + m)
    for (const a of pfActions) o.out('action: ' + a)
    writeRecord(o, { repo: P, status: 'BLOCKED', ci: 'not-run', missing: pfMissing, actions: pfActions })
    return 3
  }

  const withCi = !o.withoutCi
  let ci = 'not-run'
  if (o.withoutCi) {
    if (pf.status === 'BLOCKED') {
      ci = 'BLOCKED(no-workflow-scope)'
      o.out('CI: BLOCKED(no-workflow-scope)')
      for (const a of pfActions) o.out('action: ' + a)
    } else {
      ci = 'skipped by --without-ci'
      o.out('CI: skipped by --without-ci')
    }
  }

  const branch = (await ghJson<{ default_branch: string }>(o.token, ['repos/' + P], { run })).default_branch
  const head = (await ghJson<{ object: { sha: string } }>(o.token, ['repos/' + P + '/git/ref/heads/' + branch], { run })).object.sha
  const treeSha = (await ghJson<{ tree: { sha: string } }>(o.token, ['repos/' + P + '/git/commits/' + head], { run })).tree.sha
  const tree = await ghJson<{ truncated?: boolean; tree: RemoteBlobEntry[] }>(o.token, ['repos/' + P + '/git/trees/' + treeSha + '?recursive=1'], { run })
  if (tree.truncated) throw new Error('git tree truncated for ' + P)
  const remote = new Map<string, string>()
  for (const entry of tree.tree) if (entry.type === 'blob') remote.set(entry.path, entry.sha)

  const expected = loadSeed(withCi)
  const plan = seedPlan(expected.map(file => ({ path: file.path, content: blobSha(file.content) })), remote)

  if (plan.kind === 'unchanged') {
    o.out('STATUS: UNCHANGED head=' + head)
    let code = 0
    if (remote.has(WORKFLOW_PATH)) {
      const report = await reportCi(o, head)
      o.out('CI: ' + report.verdict + ' runs=' + report.runs)
      ci = report.verdict
      code = report.verdict === 'success' ? 0 : 1
    }
    writeRecord(o, { repo: P, status: 'UNCHANGED', ci, missing: pfMissing, actions: pfActions, head })
    return code
  }

  if (plan.kind === 'diff') {
    o.out('STATUS: DIFF')
    for (const problem of plan.problems) o.out('problem: ' + problem)
    writeRecord(o, { repo: P, status: 'DIFF', ci, missing: pfMissing, actions: pfActions, head, problems: plan.problems })
    return 1
  }

  const files = expected.filter(file => plan.paths.includes(file.path))
  const blobs: { path: string; sha: string }[] = []
  for (const file of files) {
    assertClean(file.path, file.content)
    const blob = await ghJson<{ sha: string }>(o.token, ['repos/' + P + '/git/blobs', '-X', 'POST', '--input', '-'], {
      run,
      input: JSON.stringify({ content: Buffer.from(file.content, 'utf8').toString('base64'), encoding: 'base64' }),
    })
    blobs.push({ path: file.path, sha: blob.sha })
  }
  const newTree = await ghJson<{ sha: string }>(o.token, ['repos/' + P + '/git/trees', '-X', 'POST', '--input', '-'], {
    run,
    input: JSON.stringify({
      base_tree: treeSha,
      tree: blobs.map(blob => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha })),
    }),
  })
  const paths = blobs.map(blob => blob.path)
  let message = 'feat: add text utilities with tests'
  if (paths.includes(WORKFLOW_PATH)) {
    message = paths.length === 1 ? 'ci: add test workflow' : 'feat: add text utilities with tests and a test workflow'
  }
  const messageProblems = commitProblems(message)
  if (messageProblems.length > 0) throw new Error(messageProblems.join('; '))
  const commit = await ghJson<{ sha: string }>(o.token, ['repos/' + P + '/git/commits', '-X', 'POST', '--input', '-'], {
    run,
    input: JSON.stringify({ message, tree: newTree.sha, parents: [head] }),
  })
  await ghJson(o.token, ['repos/' + P + '/git/refs/heads/' + branch, '-X', 'PATCH', '--input', '-'], {
    run,
    input: JSON.stringify({ sha: commit.sha, force: false }),
  })
  o.out('STATUS: SEEDED commit=' + commit.sha + ' files=' + paths.length)

  let code = 0
  if (withCi) {
    const report = await reportCi(o, commit.sha)
    o.out('CI: ' + report.verdict + ' runs=' + report.runs)
    ci = report.verdict
    code = report.verdict === 'success' ? 0 : 1
  }
  writeRecord(o, { repo: P, status: 'SEEDED', ci, missing: pfMissing, actions: pfActions, head, commit: commit.sha, files: paths.length })
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const known = ['--without-ci']
  if (args.some(arg => !known.includes(arg))) {
    console.error('usage: node tests/live/seed-playground.ts [--without-ci]')
    process.exitCode = 2
  } else if (process.env.SUPERAGENT_CLAUDE_LIVE !== '1' || !process.env.SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN) {
    console.log('STATUS: SKIP (set SUPERAGENT_CLAUDE_LIVE=1 and SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN)')
    process.exitCode = 0
  } else {
    try {
      process.exitCode = await runSeed({
        token: process.env.SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN,
        withoutCi: args.includes('--without-ci'),
        out: console.log,
        recordDir: resolve('.docs/acceptance/raw'),
      })
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
