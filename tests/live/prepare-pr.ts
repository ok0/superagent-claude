import { assertAllowedRepo } from './guard.ts'
import { AGENT_BRANCH, attributionProblems, commitProblems, contentProblems, isTestFile } from './rules.ts'

export interface PrepareSpec { path: string; fixture: string; commitMessage: string; comment: string }
export type OwnerCall = <T = unknown>(args: string[], options?: { input?: string }) => Promise<T>
export interface PreparedPull { number: number; html_url: string; branch: string; baseSha: string; headSha: string; commentAt: string; commentUrl: string }

export const prepareBranch = (run: string): string => 'agent/failing-check-' + run

export function prepareProblems(o: { spec: PrepareSpec; title: string; body: string; branch: string; agent: string }): string[] {
  const problems: string[] = []
  if (!AGENT_BRANCH.test(o.branch)) problems.push('branch must match agent/…')
  if (!isTestFile(o.spec.path) || !/^api\/test\/[A-Za-z0-9._-]+\.test\.ts$/.test(o.spec.path)) problems.push('path must be one test file under api/test')
  problems.push(
    ...contentProblems('title', o.title),
    ...contentProblems('body', o.body),
    ...contentProblems('comment', o.spec.comment),
    ...contentProblems('branch', o.branch),
    ...contentProblems('commit message', o.spec.commitMessage),
  )
  problems.push(...attributionProblems('body', o.body), ...attributionProblems('comment', o.spec.comment))
  problems.push(...commitProblems(o.spec.commitMessage))
  if (!o.spec.comment.startsWith('@' + o.agent + ' ')) problems.push('comment must start with the agent mention')
  if (o.body.includes('@' + o.agent)) problems.push('pull request body must not mention the agent')
  return problems
}

export function preparedProblems(expected: string, actual: string | null): string[] {
  if (actual === null) return ['prepared test missing']
  if (actual !== expected) return ['prepared test changed']
  return []
}

export async function preparePull(o: {
  call: OwnerCall
  repo: string
  base: { branch: string; sha: string }
  branch: string
  spec: PrepareSpec
  title: string
  body: string
  content: string
  agent: string
  checksOf: (sha: string) => Promise<string>
  onCreated: (pull: { number: number; ref: string }) => void
}): Promise<PreparedPull> {
  const repo = assertAllowedRepo(o.repo)
  const problems = prepareProblems({ spec: o.spec, title: o.title, body: o.body, branch: o.branch, agent: o.agent })
  if (problems.length > 0) throw new Error(problems.join('; '))
  const baseCommit = await o.call<{ tree: { sha: string } }>(['repos/' + repo + '/git/commits/' + o.base.sha])
  const blob = await o.call<{ sha: string }>(['repos/' + repo + '/git/blobs', '-X', 'POST', '--input', '-'], {
    input: JSON.stringify({ content: Buffer.from(o.content, 'utf8').toString('base64'), encoding: 'base64' }),
  })
  const tree = await o.call<{ sha: string }>(['repos/' + repo + '/git/trees', '-X', 'POST', '--input', '-'], {
    input: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: [{ path: o.spec.path, mode: '100644', type: 'blob', sha: blob.sha }] }),
  })
  const commit = await o.call<{ sha: string }>(['repos/' + repo + '/git/commits', '-X', 'POST', '--input', '-'], {
    input: JSON.stringify({ message: o.spec.commitMessage, tree: tree.sha, parents: [o.base.sha] }),
  })
  await o.call(['repos/' + repo + '/git/refs', '-X', 'POST', '--input', '-'], {
    input: JSON.stringify({ ref: 'refs/heads/' + o.branch, sha: commit.sha }),
  })
  const pull = await o.call<{ number: number; html_url: string }>(['repos/' + repo + '/pulls', '-X', 'POST', '--input', '-'], {
    input: JSON.stringify({ title: o.title, body: o.body, head: o.branch, base: o.base.branch }),
  })
  o.onCreated({ number: pull.number, ref: o.branch })
  const verdict = await o.checksOf(commit.sha)
  if (verdict !== 'failure') throw new Error('the prepared pull request checks ended with ' + verdict + ', expected failure')
  const comment = await o.call<{ html_url: string; created_at: string }>(['repos/' + repo + '/issues/' + pull.number + '/comments', '-X', 'POST', '--input', '-'], {
    input: JSON.stringify({ body: o.spec.comment }),
  })
  return { number: pull.number, html_url: pull.html_url, branch: o.branch, baseSha: o.base.sha, headSha: commit.sha, commentAt: comment.created_at, commentUrl: comment.html_url }
}
