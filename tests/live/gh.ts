import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertAllowedRepo, assertApiTarget } from './guard.ts'

export interface RunResult { code: number; stdout: Buffer; stderr: string }

export type Runner = (args: readonly string[], env: Readonly<Record<string, string>>, input?: string) => Promise<RunResult>

const TIMEOUT_MS = 120_000

export const runGh: Runner = (args, env, input) => new Promise((resolve, reject) => {
  const child = spawn('gh', [...args], { env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const out: Buffer[] = []
  const err: Buffer[] = []
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    resolve({ code: 124, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
  }, TIMEOUT_MS)
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
  child.on('error', error => {
    clearTimeout(timer)
    reject(error)
  })
  child.on('close', code => {
    clearTimeout(timer)
    resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
  })
  child.stdin.end(input)
})

export async function ghRaw(token: string, args: readonly string[], options: { input?: string; run?: Runner } = {}): Promise<RunResult> {
  assertApiTarget(args)
  return (options.run ?? runGh)(['api', ...args], {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    GH_TOKEN: token,
    GH_PROMPT_DISABLED: '1',
  }, options.input)
}

export async function ghJson<T = unknown>(token: string, args: readonly string[], options: { input?: string; paginate?: boolean; run?: Runner } = {}): Promise<T> {
  const callArgs = options.paginate ? [...args, '--paginate', '--slurp'] : [...args]
  const result = await ghRaw(token, callArgs, options)
  if (result.code !== 0) throw new Error('gh api failed: ' + (args[0] ?? ''))
  const text = result.stdout.toString('utf8')
  if (text.trim() === '') return undefined as T
  const parsed: unknown = JSON.parse(text)
  if (options.paginate) return (parsed as unknown[][]).flat() as T
  return parsed as T
}

export async function ghStatus(token: string, path: string, options: { run?: Runner } = {}): Promise<number> {
  const result = await ghRaw(token, [path, '--silent'], options)
  if (result.code === 0) return 200
  return Number(/HTTP (\d{3})/.exec(result.stderr)?.[1]) || 0
}

export async function tokenScopes(token: string, options: { run?: Runner } = {}): Promise<string[]> {
  const result = await ghRaw(token, ['user', '-i'], options)
  if (result.code !== 0) throw new Error('gh api failed: user')
  const header = /^x-oauth-scopes:\s*(.*)$/im.exec(result.stdout.toString('utf8'))
  if (!header) return []
  return (header[1] ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== '')
}

interface RemoteCommit { tree: { sha: string } }
interface RemoteTree { truncated?: boolean; tree: { path: string; type: string; sha: string }[] }
interface RemoteBlob { content: string }

export async function downloadTree(token: string, repo: string, commitSha: string, dir: string, options: { run?: Runner } = {}): Promise<string[]> {
  assertAllowedRepo(repo)
  const commit = await ghJson<RemoteCommit>(token, ['repos/' + repo + '/git/commits/' + commitSha], options)
  const tree = await ghJson<RemoteTree>(token, ['repos/' + repo + '/git/trees/' + commit.tree.sha + '?recursive=1'], options)
  if (tree.truncated) throw new Error('git tree truncated for ' + repo)
  const paths: string[] = []
  for (const entry of tree.tree) {
    if (entry.type !== 'blob') continue
    const blob = await ghJson<RemoteBlob>(token, ['repos/' + repo + '/git/blobs/' + entry.sha], options)
    const target = join(dir, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, Buffer.from(blob.content.replace(/\s+/g, ''), 'base64'))
    paths.push(entry.path)
  }
  return paths.sort()
}
