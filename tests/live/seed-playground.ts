import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ghJson, ghLocalJson, ghRaw, ghStatus, localIdentity, type Runner } from './gh.ts'
import { assertAllowedRepo } from './guard.ts'
import { assertClean, blobSha, ciBlockedLabel, commitProblems, preflight, SEED_VERSION_PATH, seedPlan, WORKFLOW_PATH, type PreflightMissing, type SeedFile } from './rules.ts'

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
  upgrade?: boolean
  run?: Runner
  out: (line: string) => void
  recordDir?: string
  pollMs?: number
  ciTimeoutMs?: number
}

interface SeedCommit { sha: string; via: 'owner' | 'local-gh'; paths: string[]; message: string }

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
  commits?: SeedCommit[]
  removed?: string[]
  local?: { login: string | null }
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

const gitMessage = 'feat: add a task tracker api workspace'
const workflowMessage = 'ci: add test workflow'
const UPGRADE_MESSAGE = 'feat: replace the seed with a task tracker api workspace'
const WORKFLOW_UPDATE_MESSAGE = 'ci: install, typecheck and test every workspace'

interface UpgradeContext {
  branch: string
  head: string
  treeSha: string
  remote: Map<string, string>
  expected: SeedFile[]
  withCi: boolean
  ci: string
  pfMissing: PreflightMissing[]
  pfActions: string[]
  localRecord: { login: string | null }
}

async function upgradeSeed(o: SeedOptions, ctx: UpgradeContext): Promise<number> {
  const P = PLAYGROUND
  const run = o.run
  const pkg = ctx.expected.filter(file => file.path !== WORKFLOW_PATH)
  for (const file of pkg) assertClean(file.path, file.content)
  const changed = pkg.filter(file => ctx.remote.get(file.path) !== blobSha(file.content))
  const removed = [...ctx.remote.keys()].filter(path => !path.startsWith('.github/workflows/') && !pkg.some(file => file.path === path)).sort()
  const workflow = ctx.expected.find(file => file.path === WORKFLOW_PATH)
  const workflowChange = workflow !== undefined && ctx.remote.get(WORKFLOW_PATH) !== blobSha(workflow.content)
  const workflowCommitMessage = ctx.remote.has(WORKFLOW_PATH) ? WORKFLOW_UPDATE_MESSAGE : workflowMessage
  const messages = [UPGRADE_MESSAGE, workflowChange ? workflowCommitMessage : undefined]
  for (const message of messages) {
    if (message === undefined) continue
    const problems = commitProblems(message)
    if (problems.length > 0) throw new Error(problems.join('; '))
  }

  const blobs: { path: string; sha: string }[] = []
  for (const file of changed) {
    const blob = await ghJson<{ sha: string }>(o.token, ['repos/' + P + '/git/blobs', '-X', 'POST', '--input', '-'], {
      run,
      input: JSON.stringify({ content: Buffer.from(file.content, 'utf8').toString('base64'), encoding: 'base64' }),
    })
    blobs.push({ path: file.path, sha: blob.sha })
  }
  const newTree = await ghJson<{ sha: string }>(o.token, ['repos/' + P + '/git/trees', '-X', 'POST', '--input', '-'], {
    run,
    input: JSON.stringify({
      base_tree: ctx.treeSha,
      tree: [
        ...blobs.map(blob => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha })),
        ...removed.map(path => ({ path, mode: '100644', type: 'blob', sha: null })),
      ],
    }),
  })
  const commit = await ghJson<{ sha: string }>(o.token, ['repos/' + P + '/git/commits', '-X', 'POST', '--input', '-'], {
    run,
    input: JSON.stringify({ message: UPGRADE_MESSAGE, tree: newTree.sha, parents: [ctx.head] }),
  })
  await ghJson(o.token, ['repos/' + P + '/git/refs/heads/' + ctx.branch, '-X', 'PATCH', '--input', '-'], {
    run,
    input: JSON.stringify({ sha: commit.sha, force: false }),
  })
  const commits: SeedCommit[] = [{ sha: commit.sha, via: 'owner', paths: [...changed.map(file => file.path), ...removed], message: UPGRADE_MESSAGE }]
  let current = commit.sha

  if (workflow && workflowChange) {
    const remoteSha = ctx.remote.get(WORKFLOW_PATH)
    const created = await ghLocalJson<{ commit: { sha: string } }>(['repos/' + P + '/contents/' + WORKFLOW_PATH, '-X', 'PUT', '--input', '-'], {
      run,
      input: JSON.stringify({ message: workflowCommitMessage, content: Buffer.from(workflow.content, 'utf8').toString('base64'), branch: ctx.branch, ...(remoteSha ? { sha: remoteSha } : {}) }),
    })
    current = created.commit.sha
    commits.push({ sha: current, via: 'local-gh', paths: [WORKFLOW_PATH], message: workflowCommitMessage })
  }

  o.out('STATUS: UPGRADED commits=' + commits.length + ' head=' + current)
  for (const entry of commits) o.out('commit: ' + entry.sha + ' via=' + entry.via + ' files=' + entry.paths.length)
  for (const path of removed) o.out('removed: ' + path)

  let code = 0
  let ci = ctx.ci
  if (ctx.withCi) {
    const report = await reportCi(o, current)
    o.out('CI: ' + report.verdict + ' runs=' + report.runs)
    ci = report.verdict
    code = report.verdict === 'success' ? 0 : 1
  }
  writeRecord(o, { repo: P, status: 'UPGRADED', ci, missing: ctx.pfMissing, actions: ctx.pfActions, head: ctx.head, commit: current, files: changed.length, removed, commits, local: ctx.localRecord })
  return code
}

export async function runSeed(o: SeedOptions): Promise<number> {
  const P = PLAYGROUND
  const run = o.run
  const repoStatus = await ghStatus(o.token, 'repos/' + P, { run })
  const actionsEnabled = repoStatus === 200 ? (await ghJson<{ enabled?: boolean }>(o.token, ['repos/' + P + '/actions/permissions'], { run })).enabled === true : true
  const local = await localIdentity({ run })
  const pf = preflight({ repoStatus, localLogin: local.login, localScopes: local.scopes, actionsEnabled })
  const pfActions = pf.status === 'BLOCKED' ? pf.actions : []
  const pfMissing: PreflightMissing[] = pf.status === 'BLOCKED' ? pf.missing : []
  const localRecord = { login: local.login }

  if (pf.status === 'BLOCKED' && (pfMissing.includes('repo-access') || !o.withoutCi)) {
    o.out('STATUS: BLOCKED')
    for (const m of pfMissing) o.out('missing: ' + m)
    for (const a of pfActions) o.out('action: ' + a)
    writeRecord(o, { repo: P, status: 'BLOCKED', ci: 'not-run', missing: pfMissing, actions: pfActions, local: localRecord })
    return 3
  }

  const withCi = !o.withoutCi
  let ci = 'not-run'
  if (o.withoutCi) {
    if (pf.status === 'BLOCKED') {
      ci = ciBlockedLabel(pfMissing)
      o.out('CI: ' + ci)
      for (const a of pfActions) o.out('action: ' + a)
    } else {
      ci = 'skipped by --without-ci'
      o.out('CI: skipped by --without-ci')
    }
  }

  const branch = (await ghJson<{ default_branch: string }>(o.token, ['repos/' + P], { run })).default_branch
  const headRead = await ghRaw(o.token, ['repos/' + P + '/git/ref/heads/' + branch], { run })
  let head: string | null = null
  let treeSha: string | null = null
  const remote = new Map<string, string>()
  if (headRead.code === 0) {
    head = (JSON.parse(headRead.stdout.toString('utf8')) as { object: { sha: string } }).object.sha
    treeSha = (await ghJson<{ tree: { sha: string } }>(o.token, ['repos/' + P + '/git/commits/' + head], { run })).tree.sha
    const tree = await ghJson<{ truncated?: boolean; tree: RemoteBlobEntry[] }>(o.token, ['repos/' + P + '/git/trees/' + treeSha + '?recursive=1'], { run })
    if (tree.truncated) throw new Error('git tree truncated for ' + P)
    for (const entry of tree.tree) if (entry.type === 'blob') remote.set(entry.path, entry.sha)
  } else if (/HTTP 409/.test(headRead.stderr)) {
    o.out('REPO: empty')
  } else {
    throw new Error('gh api failed: repos/' + P + '/git/ref/heads/' + branch)
  }

  const expected = loadSeed(withCi)
  const versionFile = expected.find(file => file.path === SEED_VERSION_PATH)
  const sameVersion = versionFile !== undefined && remote.get(SEED_VERSION_PATH) === blobSha(versionFile.content)
  if (o.upgrade && head !== null && treeSha !== null && !sameVersion) {
    return await upgradeSeed(o, { branch, head, treeSha, remote, expected, withCi, ci, pfMissing, pfActions, localRecord })
  }
  const plan = seedPlan(expected.map(file => ({ path: file.path, content: blobSha(file.content) })), remote)

  if (plan.kind === 'unchanged') {
    o.out('STATUS: UNCHANGED head=' + head)
    let code = 0
    if (remote.has(WORKFLOW_PATH) && head !== null) {
      const report = await reportCi(o, head)
      o.out('CI: ' + report.verdict + ' runs=' + report.runs)
      ci = report.verdict
      code = report.verdict === 'success' ? 0 : 1
    }
    writeRecord(o, { repo: P, status: 'UNCHANGED', ci, missing: pfMissing, actions: pfActions, head: head ?? undefined, local: localRecord })
    return code
  }

  if (plan.kind === 'diff') {
    o.out('STATUS: DIFF')
    for (const problem of plan.problems) o.out('problem: ' + problem)
    if (!sameVersion) o.out('action: run node tests/live/seed-playground.ts --upgrade to replace the seed')
    writeRecord(o, { repo: P, status: 'DIFF', ci, missing: pfMissing, actions: pfActions, head: head ?? undefined, problems: plan.problems, local: localRecord })
    return 1
  }

  const files = expected.filter(file => plan.paths.includes(file.path))
  for (const file of files) assertClean(file.path, file.content)
  const pkg = files.filter(file => file.path !== WORKFLOW_PATH)
  const workflow = files.find(file => file.path === WORKFLOW_PATH)
  const first = pkg[0]
  const ownerFirst = first !== undefined && head === null ? first : undefined
  const rest = ownerFirst ? pkg.slice(1) : pkg
  const messages = [ownerFirst ? 'chore: add ' + ownerFirst.path : undefined, rest.length > 0 ? gitMessage : undefined, workflow ? workflowMessage : undefined]
  for (const message of messages) {
    if (message === undefined) continue
    const problems = commitProblems(message)
    if (problems.length > 0) throw new Error(problems.join('; '))
  }

  const commits: SeedCommit[] = []
  let current: string | null = head
  let currentTree: string | null = treeSha
  if (ownerFirst) {
    const created = await ghJson<{ commit: { sha: string; tree: { sha: string } } }>(o.token, ['repos/' + P + '/contents/' + ownerFirst.path, '-X', 'PUT', '--input', '-'], {
      run,
      input: JSON.stringify({ message: 'chore: add ' + ownerFirst.path, content: Buffer.from(ownerFirst.content, 'utf8').toString('base64') }),
    })
    current = created.commit.sha
    currentTree = created.commit.tree.sha
    commits.push({ sha: current, via: 'owner', paths: [ownerFirst.path], message: 'chore: add ' + ownerFirst.path })
  }

  if (rest.length > 0) {
    const blobs: { path: string; sha: string }[] = []
    for (const file of rest) {
      const blob = await ghJson<{ sha: string }>(o.token, ['repos/' + P + '/git/blobs', '-X', 'POST', '--input', '-'], {
        run,
        input: JSON.stringify({ content: Buffer.from(file.content, 'utf8').toString('base64'), encoding: 'base64' }),
      })
      blobs.push({ path: file.path, sha: blob.sha })
    }
    const newTree = await ghJson<{ sha: string }>(o.token, ['repos/' + P + '/git/trees', '-X', 'POST', '--input', '-'], {
      run,
      input: JSON.stringify({
        base_tree: currentTree,
        tree: blobs.map(blob => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha })),
      }),
    })
    const commit = await ghJson<{ sha: string }>(o.token, ['repos/' + P + '/git/commits', '-X', 'POST', '--input', '-'], {
      run,
      input: JSON.stringify({ message: gitMessage, tree: newTree.sha, parents: [current] }),
    })
    await ghJson(o.token, ['repos/' + P + '/git/refs/heads/' + branch, '-X', 'PATCH', '--input', '-'], {
      run,
      input: JSON.stringify({ sha: commit.sha, force: false }),
    })
    current = commit.sha
    commits.push({ sha: commit.sha, via: 'owner', paths: rest.map(file => file.path), message: gitMessage })
  }

  if (workflow) {
    const created = await ghLocalJson<{ commit: { sha: string } }>(['repos/' + P + '/contents/' + WORKFLOW_PATH, '-X', 'PUT', '--input', '-'], {
      run,
      input: JSON.stringify({ message: workflowMessage, content: Buffer.from(workflow.content, 'utf8').toString('base64'), branch }),
    })
    current = created.commit.sha
    commits.push({ sha: current, via: 'local-gh', paths: [WORKFLOW_PATH], message: workflowMessage })
  }

  o.out('STATUS: SEEDED commits=' + commits.length + ' head=' + current)
  for (const commit of commits) o.out('commit: ' + commit.sha + ' via=' + commit.via + ' files=' + commit.paths.length)

  let code = 0
  if (workflow && current !== null) {
    const report = await reportCi(o, current)
    o.out('CI: ' + report.verdict + ' runs=' + report.runs)
    ci = report.verdict
    code = report.verdict === 'success' ? 0 : 1
  }
  writeRecord(o, { repo: P, status: 'SEEDED', ci, missing: pfMissing, actions: pfActions, head: head ?? undefined, commit: current ?? undefined, files: files.length, commits, local: localRecord })
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const known = ['--without-ci', '--upgrade']
  if (args.some(arg => !known.includes(arg))) {
    console.error('usage: node tests/live/seed-playground.ts [--without-ci] [--upgrade]')
    process.exitCode = 2
  } else if (process.env.SUPERAGENT_CLAUDE_LIVE !== '1' || !process.env.SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN) {
    console.log('STATUS: SKIP (set SUPERAGENT_CLAUDE_LIVE=1 and SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN)')
    process.exitCode = 0
  } else {
    try {
      process.exitCode = await runSeed({
        token: process.env.SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN,
        withoutCi: args.includes('--without-ci'),
        upgrade: args.includes('--upgrade'),
        out: console.log,
        recordDir: resolve('.docs/acceptance/raw'),
      })
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
