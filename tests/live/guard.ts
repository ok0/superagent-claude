export const ALLOWED_REPOS = ['ok0/superagent-claude', 'ok0/superagent-claude-playground', 'ok0/superagent-claude-playground-readonly'] as const

export function isAllowedRepo(repo: unknown): boolean {
  if (typeof repo !== 'string') return false
  const lower = repo.toLowerCase()
  return ALLOWED_REPOS.some(allowed => allowed === lower)
}

export function assertAllowedRepo(repo: unknown): string {
  if (isAllowedRepo(repo)) return repo as string
  throw new Error('repository not allowed: ' + JSON.stringify(String(repo)))
}

const WRITE_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input']

export function assertApiTarget(args: readonly string[]): void {
  if (args.some(arg => arg === '--hostname' || arg.startsWith('--hostname='))) throw new Error('GitHub host override not allowed')
  const endpoint = (args[0] ?? '').replace(/^\/+/, '')
  const path = endpoint.split('?')[0] ?? ''
  if (path === '') throw new Error('GitHub endpoint not allowed: ""')
  if (path.startsWith('repos/')) {
    const segments = path.split('/')
    const owner = segments[1]
    const name = segments[2]
    if (!owner || !name) throw new Error('GitHub endpoint not allowed: ' + path)
    assertAllowedRepo(owner + '/' + name)
    return
  }
  if (path === 'graphql') {
    let query: string | undefined
    for (let i = 0; i < args.length - 1 && query === undefined; i++) {
      const flag = args[i]
      const value = args[i + 1] ?? ''
      if (flag !== undefined && WRITE_FLAGS.includes(flag) && value.startsWith('query=')) query = value.slice('query='.length)
    }
    if (query === undefined) throw new Error('GitHub graphql query missing')
    if (/\bmutation\b/i.test(query)) throw new Error('GitHub graphql mutation not allowed')
    const opened = query.match(/repository\s*\(/g)?.length ?? 0
    const matches = [...query.matchAll(/repository\s*\(\s*owner:\s*"([^"]*)"\s*,\s*name:\s*"([^"]*)"\s*\)/g)]
    if (opened === 0 || opened !== matches.length) throw new Error('GitHub graphql repository not allowed')
    for (const match of matches) assertAllowedRepo(match[1] + '/' + match[2])
    return
  }
  if (path === 'user') {
    if (args.some(arg => WRITE_FLAGS.includes(arg))) throw new Error('GitHub endpoint not allowed: user with fields')
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]
      if (flag === '-X' || flag === '--method') {
        if ((args[i + 1] ?? '').toUpperCase() !== 'GET') throw new Error('GitHub endpoint not allowed: user with method')
      }
    }
    return
  }
  throw new Error('GitHub endpoint not allowed: ' + (path.split('/')[0] ?? ''))
}
