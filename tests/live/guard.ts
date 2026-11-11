import { liveTarget, TARGET_NOT_CONFIGURED, type LiveEnv } from './target.ts'

const WRITE_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input']

function roleOf(repo: unknown, env: LiveEnv): 'target' | 'report' | null {
  if (typeof repo !== 'string') return null
  const t = liveTarget(env)
  if (t === null) return null
  const lower = repo.toLowerCase()
  if (lower === t.repo.toLowerCase()) return 'target'
  if (t.reportRepo && lower === t.reportRepo.toLowerCase()) return 'report'
  return null
}

export function isAllowedRepo(repo: unknown, env: LiveEnv = process.env): boolean {
  return roleOf(repo, env) !== null
}

export function assertAllowedRepo(repo: unknown, env: LiveEnv = process.env): string {
  if (liveTarget(env) === null) throw new Error(TARGET_NOT_CONFIGURED)
  if (isAllowedRepo(repo, env)) return repo as string
  throw new Error('repository not allowed: ' + JSON.stringify(String(repo)))
}

function methodOf(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '-X' || flag === '--method') return (args[i + 1] ?? '').toUpperCase()
    if (flag !== undefined && flag.startsWith('--method=')) return flag.slice('--method='.length).toUpperCase()
  }
  return 'GET'
}

export function assertApiTarget(args: readonly string[], env: LiveEnv = process.env): void {
  if (args.some(arg => arg === '--hostname' || arg.startsWith('--hostname=')))
    throw new Error('GitHub host override not allowed')
  if (liveTarget(env) === null) throw new Error(TARGET_NOT_CONFIGURED)
  const endpoint = (args[0] ?? '').replace(/^\/+/, '')
  const path = endpoint.split('?')[0] ?? ''
  if (path === '') throw new Error('GitHub endpoint not allowed: ""')
  if (path.startsWith('repos/')) {
    const segments = path.split('/')
    const owner = segments[1]
    const name = segments[2]
    if (!owner || !name) throw new Error('GitHub endpoint not allowed: ' + path)
    assertAllowedRepo(owner + '/' + name, env)
    const role = roleOf(owner + '/' + name, env)
    if (role === 'report') {
      if (methodOf(args) !== 'GET' || args.some(a => WRITE_FLAGS.includes(a)))
        throw new Error('GitHub endpoint not allowed: read-only repository ' + path)
      return
    }
    if (segments[3] === 'pulls' && methodOf(args) === 'PUT') {
      const isMerge = segments.length === 6 && /^\d+$/.test(segments[4] ?? '') && segments[5] === 'merge'
      if (!isMerge) throw new Error('GitHub endpoint not allowed: PUT ' + path)
    }
    return
  }
  if (path === 'graphql') {
    let query: string | undefined
    for (let i = 0; i < args.length - 1 && query === undefined; i++) {
      const flag = args[i]
      const value = args[i + 1] ?? ''
      if (flag !== undefined && WRITE_FLAGS.includes(flag) && value.startsWith('query='))
        query = value.slice('query='.length)
    }
    if (query === undefined) throw new Error('GitHub graphql query missing')
    if (/\bmutation\b/i.test(query)) throw new Error('GitHub graphql mutation not allowed')
    const opened = query.match(/repository\s*\(/g)?.length ?? 0
    const matches = [...query.matchAll(/repository\s*\(\s*owner:\s*"([^"]*)"\s*,\s*name:\s*"([^"]*)"\s*\)/g)]
    if (opened === 0 || opened !== matches.length) throw new Error('GitHub graphql repository not allowed')
    for (const match of matches) assertAllowedRepo(match[1] + '/' + match[2], env)
    return
  }
  if (path === 'user') {
    if (args.some(arg => WRITE_FLAGS.includes(arg))) throw new Error('GitHub endpoint not allowed: user with fields')
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]
      if (flag === '-X' || flag === '--method') {
        if ((args[i + 1] ?? '').toUpperCase() !== 'GET')
          throw new Error('GitHub endpoint not allowed: user with method')
      }
    }
    return
  }
  throw new Error('GitHub endpoint not allowed: ' + (path.split('/')[0] ?? ''))
}
