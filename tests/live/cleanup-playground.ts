import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ghJson, type Runner } from './gh.ts'
import { assertAllowedRepo } from './guard.ts'
import { requireLiveTarget, liveTarget, TARGET_SKIP_LINE, type LiveTarget } from './target.ts'
import {
  AGENT_BRANCH,
  cleanupTargets,
  type CleanupTargets,
  type RemoteBranch,
  type RemoteIssue,
  type RemotePull,
} from './rules.ts'

export interface CleanupOptions {
  token: string
  apply: boolean
  run?: Runner
  out: (line: string) => void
  recordDir?: string
}

interface RepoRecord {
  repo: string
  reportOnly: boolean
  targets: { issues: number[]; pulls: number[]; branches: string[] }
  closed: { issues: number[]; pulls: number[] }
  deleted: string[]
  remaining?: { issues: number; pulls: number; branches: number }
  headBefore: string
  headAfter?: string
}

async function listAll<T>(o: CleanupOptions, path: string): Promise<T[]> {
  return ghJson<T[]>(o.token, [path], { paginate: true, run: o.run })
}

async function readLists(
  o: CleanupOptions,
  target: LiveTarget,
  repo: string,
  defaultBranch: string,
): Promise<CleanupTargets> {
  const issues = await listAll<RemoteIssue>(o, 'repos/' + repo + '/issues?state=open&per_page=100')
  const pulls = await listAll<RemotePull>(o, 'repos/' + repo + '/pulls?state=open&per_page=100')
  const branches = await listAll<RemoteBranch>(o, 'repos/' + repo + '/branches?per_page=100')
  return cleanupTargets({
    repo,
    defaultBranch,
    issues,
    pulls,
    branches,
    authors: [target.ownerLogin, target.agentLogin],
    agent: target.agentLogin,
  })
}

function writeRecord(o: CleanupOptions, body: { apply: boolean; repos: RepoRecord[]; errors: string[] }): void {
  if (!o.recordDir) return
  mkdirSync(o.recordDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(join(o.recordDir, 'cleanup-' + stamp + '.json'), JSON.stringify(body, null, 2) + '\n')
}

export async function runCleanup(o: CleanupOptions): Promise<number> {
  const errors: string[] = []
  const repos: RepoRecord[] = []
  const target = requireLiveTarget()
  const targetRepos = [...(target.reportRepo ? [target.reportRepo] : []), target.repo]

  for (const repo of targetRepos) {
    assertAllowedRepo(repo)
    const info = await ghJson<{ default_branch: string }>(o.token, ['repos/' + repo], { run: o.run })
    const defaultBranch = info.default_branch
    const headBefore = (
      await ghJson<{ object: { sha: string } }>(o.token, ['repos/' + repo + '/git/ref/heads/' + defaultBranch], {
        run: o.run,
      })
    ).object.sha
    const t = await readLists(o, target, repo, defaultBranch)

    o.out(
      repo +
        ' issues=' +
        t.issues.length +
        ' pulls=' +
        t.pulls.length +
        ' branches=' +
        t.branches.length +
        (t.reportOnly ? ' report-only' : ''),
    )
    for (const n of t.issues) o.out('  issue #' + n)
    for (const n of t.pulls) o.out('  pull #' + n)
    for (const name of t.branches) o.out('  branch ' + name)

    const record: RepoRecord = {
      repo,
      reportOnly: t.reportOnly,
      targets: { issues: t.issues, pulls: t.pulls, branches: t.branches },
      closed: { issues: [], pulls: [] },
      deleted: [],
      headBefore,
    }

    if (o.apply && !t.reportOnly) {
      for (const n of t.pulls) {
        try {
          await ghJson(o.token, ['repos/' + repo + '/pulls/' + n, '-X', 'PATCH', '-f', 'state=closed'], { run: o.run })
          record.closed.pulls.push(n)
        } catch {
          errors.push(repo + ' pull ' + n + ' failed')
        }
      }
      for (const name of t.branches) {
        if (!(AGENT_BRANCH.test(name) && name !== defaultBranch)) continue
        try {
          await ghJson(o.token, ['repos/' + repo + '/git/refs/heads/' + name, '-X', 'DELETE'], { run: o.run })
          record.deleted.push(name)
        } catch {
          errors.push(repo + ' branch ' + name + ' failed')
        }
      }
      for (const n of t.issues) {
        try {
          await ghJson(
            o.token,
            ['repos/' + repo + '/issues/' + n, '-X', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=not_planned'],
            { run: o.run },
          )
          record.closed.issues.push(n)
        } catch {
          errors.push(repo + ' issue ' + n + ' failed')
        }
      }

      const after = await readLists(o, target, repo, defaultBranch)
      const headAfter = (
        await ghJson<{ object: { sha: string } }>(o.token, ['repos/' + repo + '/git/ref/heads/' + defaultBranch], {
          run: o.run,
        })
      ).object.sha
      record.remaining = { issues: after.issues.length, pulls: after.pulls.length, branches: after.branches.length }
      record.headAfter = headAfter
      o.out(
        repo +
          ' remaining issues=' +
          after.issues.length +
          ' pulls=' +
          after.pulls.length +
          ' branches=' +
          after.branches.length +
          ' head-unchanged=' +
          (headAfter === headBefore),
      )
    }

    repos.push(record)
  }

  writeRecord(o, { apply: o.apply, repos, errors })

  const clean = repos.every(
    r =>
      r.reportOnly ||
      !o.apply ||
      ((r.remaining?.issues ?? 0) + (r.remaining?.pulls ?? 0) + (r.remaining?.branches ?? 0) === 0 &&
        r.headAfter === r.headBefore),
  )
  return errors.length === 0 && clean ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const known = ['--apply']
  if (args.some(arg => !known.includes(arg))) {
    console.error('usage: node tests/live/cleanup-playground.ts [--apply]')
    process.exitCode = 2
  } else {
    let target: ReturnType<typeof liveTarget> | undefined
    try {
      target = liveTarget()
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
    if (target === null) {
      console.error(TARGET_SKIP_LINE)
      process.exitCode = 0
    } else if (target !== undefined) {
      if (process.env.ISSUECREW_LIVE !== '1' || !process.env.ISSUECREW_LIVE_OWNER_TOKEN) {
        console.log('STATUS: SKIP (set ISSUECREW_LIVE=1 and ISSUECREW_LIVE_OWNER_TOKEN)')
        process.exitCode = 0
      } else {
        try {
          process.exitCode = await runCleanup({
            token: process.env.ISSUECREW_LIVE_OWNER_TOKEN,
            apply: args.includes('--apply'),
            out: console.log,
            recordDir: resolve('.docs/acceptance/raw'),
          })
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error))
          process.exitCode = 1
        }
      }
    }
  }
}
