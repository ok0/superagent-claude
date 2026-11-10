/** A scripted stand-in for the gh and git programs behind a real Commands runner, and a recording Source host; no network and no real gh. */
import { Commands, type Exec } from '../../src/infra/commands.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import type { ReceiveResult, Ticket, Thread, ThreadRef, Trigger } from '../../src/core/index.ts'
import type { SourceContext, SourceHost } from '../../src/sources/host.ts'
import type { SourceKind } from '../../src/sources/kind.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'

export const START = Date.parse('2026-09-23T00:00:00Z')
export const AT = '2026-09-23T00:00:30Z'
export const AGENT = 'agent-bot'

export interface FakeRepository {
  access?: { push: boolean } | { status: number }
  notifications?: unknown[]
  issues?: Record<number, unknown>
  pulls?: Record<number, unknown>
  comments?: Record<number, unknown[]>
  reviewComments?: Record<number, unknown[]>
  reviews?: Record<number, unknown[]>
  checkRuns?: Record<string, unknown[]>
  statuses?: Record<string, unknown[]>
  failures?: Record<string, number>
  resolved?: Set<number>
}

export interface FakeGhScript {
  login?: string
  userStatus?: number
  repositories: Record<string, FakeRepository>
}

export interface Posted { repository: string; path: string; body: string }

export interface FakeGh {
  commands: Commands
  script: FakeGhScript
  calls: string[]
  posted: Posted[]
  execs: { program: string; args: string[]; env: Record<string, string> }[]
  requests: { method: string; path: string; fields: Record<string, string> }[]
  graphql: { query: string; variables: Record<string, string> }[]
  hold(prefix: string): { reached(): boolean; release(): void }
}

interface Hold {
  prefix: string
  reached: boolean
  gate: Promise<void>
  open: () => void
}

const fieldsOf = (args: readonly string[]): Record<string, string> => {
  const fields: Record<string, string> = {}
  args.forEach((arg, i) => {
    if (arg !== '-f' && arg !== '-F') return
    const value = args[i + 1] ?? ''
    const at = value.indexOf('=')
    if (at >= 0) fields[value.slice(0, at)] = value.slice(at + 1)
  })
  return fields
}

const failure = (status: number): Error => Object.assign(new Error('failed'), { stderr: `gh: Request failed (HTTP ${status})`, code: 1 })

export function fakeGh(script: FakeGhScript, options: { baseEnv?: Record<string, string | undefined>; apiEnv?: Record<string, string>; posted?: Posted[] } = {}): FakeGh {
  const calls: string[] = []
  const posted: Posted[] = options.posted ?? []
  const execs: FakeGh['execs'] = []
  const requests: FakeGh['requests'] = []
  const graphqlCalls: FakeGh['graphql'] = []
  const holds: Hold[] = []
  const login = script.login ?? AGENT

  const findRepository = (name: string): string | undefined => Object.keys(script.repositories).find(item => item.toLowerCase() === name.toLowerCase())

  const graphql = (fields: Record<string, string>): unknown => {
    const query = fields.query ?? ''
    const node = /^PR_(.+)_(\d+)$/.exec(fields.id ?? '')
    const name = node ? findRepository(node[1]!) : findRepository(`${fields.owner ?? ''}/${fields.name ?? ''}`)
    if (query.includes('reviewThreads')) {
      if (!name) throw failure(404)
      const repo = script.repositories[name]!
      const resolved = (repo.resolved ??= new Set<number>())
      const nodes = (repo.reviewComments?.[Number(fields.number)] ?? []).flatMap(item => {
        const reply = (item as { in_reply_to_id?: unknown }).in_reply_to_id
        if (reply !== undefined && reply !== null) return []
        const rootId = Number((item as { id: unknown }).id)
        return [{ id: 'RT_' + rootId, isResolved: resolved.has(rootId), comments: { nodes: [{ databaseId: rootId }] } }]
      })
      return { data: { repository: { pullRequest: { reviewThreads: { nodes } } } } }
    }
    if (query.includes('resolveReviewThread')) {
      const rootId = Number(/^RT_(\d+)$/.exec(fields.id ?? '')?.[1])
      const owner = Object.keys(script.repositories).find(key => Object.values(script.repositories[key]!.reviewComments ?? {}).flat().some(item => (item as { id?: unknown }).id === rootId))
      if (owner) (script.repositories[owner]!.resolved ??= new Set<number>()).add(rootId)
      return { data: { resolveReviewThread: { thread: { isResolved: true } } } }
    }
    if (query.includes('enablePullRequestAutoMerge')) {
      if (!name || !node) throw failure(404)
      const number = Number(node[2])
      const pr = script.repositories[name]!.pulls?.[number] ?? throwNotFound()
      Object.assign(pr as Record<string, unknown>, { auto_merge: { merge_method: (fields.method ?? '').toLowerCase() } })
      return { data: { enablePullRequestAutoMerge: { pullRequest: { number } } } }
    }
    throw failure(400)
  }

  const route = (path: string, args: readonly string[]): unknown => {
    if (path === 'graphql') return graphql(fieldsOf(args))
    if (path === 'user') {
      if (script.userStatus) throw failure(script.userStatus)
      return { login, id: 1, type: 'User' }
    }
    const match = /^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(path)
    if (!match) throw failure(404)
    const name = findRepository(match[1]!)
    if (!name) throw failure(404)
    const repo = script.repositories[name]!
    const rest = (match[2] ?? '').split('?')[0]!
    if (repo.failures && repo.failures[rest] !== undefined) throw failure(repo.failures[rest])
    if (!rest) {
      const access = repo.access
      if (access && 'status' in access) throw failure(access.status)
      return { full_name: name, permissions: { push: access && 'push' in access ? access.push : true } }
    }
    if (rest === 'pulls' && args.includes('POST')) {
      const fields = fieldsOf(args)
      const numbers = [...Object.keys(repo.pulls ?? {}), ...Object.keys(repo.issues ?? {})].map(Number)
      const number = 1 + Math.max(0, ...numbers)
      const created = pull(name, number, { title: fields.title, body: fields.body, user: { login, type: 'User' }, node_id: `PR_${name}_${number}`, draft: fields.draft === 'true', head: { sha: 'head-' + number, ref: fields.head, repo: { full_name: name } }, base: { ref: fields.base }, state: 'open' })
      repo.pulls ??= {}
      repo.issues ??= {}
      repo.pulls[number] = created
      repo.issues[number] = created
      return created
    }
    if (rest === 'pulls') {
      const params = new URLSearchParams((match[2] ?? '').split('?')[1] ?? '')
      const head = params.get('head')
      const state = params.get('state')
      return Object.values(repo.pulls ?? {}).filter(item => {
        const found = item as { state: string; head: { ref: string } }
        return (!state || found.state === state) && `${name.split('/')[0]}:${found.head.ref}` === head
      })
    }
    const reply = /^pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(rest)
    if (reply && args.includes('POST')) {
      const number = Number(reply[1])
      const root = Number(reply[2])
      const fields = fieldsOf(args)
      posted.push({ repository: name, path: rest, body: fields.body ?? '' })
      const id = 1000 + posted.length
      repo.reviewComments ??= {}
      ;(repo.reviewComments[number] ??= []).push({ id, body: fields.body ?? '', in_reply_to_id: root, user: { login, type: 'User' }, pull_request_url: `https://api.github.com/repos/${name}/pulls/${number}` })
      return { id }
    }
    if (/^pulls\/\d+\/merge$/.test(rest) && args.includes('PUT')) return { merged: true }
    const patch = /^pulls\/(\d+)$/.exec(rest)
    if (patch && args.includes('PATCH')) {
      const number = Number(patch[1])
      const fields = fieldsOf(args)
      const changes: Record<string, unknown> = { state: fields.state }
      if (fields.state === 'closed') changes.closed_at = new Date().toISOString()
      const current = repo.pulls?.[number] ?? throwNotFound()
      for (const store of [repo.pulls, repo.issues]) {
        const item = store?.[number]
        if (item) Object.assign(item as Record<string, unknown>, changes)
      }
      return current
    }
    if (args.includes('POST')) {
      const flag = args.indexOf('-f')
      const body = (args[flag + 1] ?? '').replace(/^body=/, '')
      posted.push({ repository: name, path: rest, body })
      const id = 1000 + posted.length
      const comment = /^issues\/(\d+)\/comments$/.exec(rest)
      if (comment) {
        const number = Number(comment[1])
        repo.comments ??= {}
        const now = new Date().toISOString()
        ;(repo.comments[number] ??= []).push({
          id, body, user: { login, type: 'User' }, html_url: `https://github.com/${name}/issues/${number}#issuecomment-${id}`, created_at: now, updated_at: now,
        })
      }
      return { id }
    }
    const issueMatch = /^issues\/(\d+)$/.exec(rest)
    if (issueMatch) return repo.issues?.[Number(issueMatch[1])] ?? throwNotFound()
    const pullMatch = /^pulls\/(\d+)$/.exec(rest)
    if (pullMatch) return repo.pulls?.[Number(pullMatch[1])] ?? throwNotFound()
    const issueComments = /^issues\/(\d+)\/comments$/.exec(rest)
    if (issueComments) return repo.comments?.[Number(issueComments[1])] ?? []
    const pullComments = /^pulls\/(\d+)\/comments$/.exec(rest)
    if (pullComments) return repo.reviewComments?.[Number(pullComments[1])] ?? []
    const reviews = /^pulls\/(\d+)\/reviews$/.exec(rest)
    if (reviews) return repo.reviews?.[Number(reviews[1])] ?? []
    const reviewComment = /^pulls\/comments\/(\d+)$/.exec(rest)
    if (reviewComment) {
      const id = Number(reviewComment[1])
      const found = Object.values(repo.reviewComments ?? {}).flat().find(item => (item as { id?: unknown }).id === id)
      return found ?? throwNotFound()
    }
    const checks = /^commits\/([^/]+)\/check-runs$/.exec(rest)
    if (checks) return { check_runs: repo.checkRuns?.[checks[1]!] ?? [] }
    const statuses = /^commits\/([^/]+)\/statuses$/.exec(rest)
    if (statuses) return repo.statuses?.[statuses[1]!] ?? []
    if (rest === 'notifications') return repo.notifications ?? []
    throwNotFound()
  }

  const throwNotFound = (): never => { throw failure(404) }

  const output = (value: unknown, args: readonly string[]): string => {
    if (args.includes('--paginate')) return JSON.stringify([value])
    if (args.includes('--include')) return 'HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\nX-RateLimit-Remaining: 4999\r\nX-RateLimit-Reset: 1790000000\r\n\r\n' + JSON.stringify(value)
    return JSON.stringify(value)
  }

  const exec: Exec = async (program, args, opts) => {
    execs.push({ program, args: [...args], env: opts.env })
    if (program === 'git') return { stdout: '' }
    if (program !== 'gh') throw new Error(`Unexpected program: ${program}`)
    if (args[0] !== 'api') throw new Error(`Unexpected gh command: ${args[0] ?? ''}`)
    const path = args[1] ?? ''
    calls.push(path)
    const method = args.indexOf('--method')
    const fields = fieldsOf(args)
    requests.push({ method: method >= 0 ? args[method + 1] ?? '' : path === 'graphql' ? 'POST' : 'GET', path, fields })
    if (path === 'graphql') {
      const { query = '', ...variables } = fields
      graphqlCalls.push({ query, variables })
    }
    for (const held of holds) {
      if (path.startsWith(held.prefix)) {
        held.reached = true
        await held.gate
      }
    }
    return { stdout: output(route(path, args), args) }
  }

  const commands = new Commands({
    apiProgram: 'gh',
    baseEnv: options.baseEnv ?? { PATH: '/usr/bin', HOME: '/home/test', LANG: 'C' },
    apiEnv: options.apiEnv ?? { GH_TOKEN: 'test-token' },
    exec,
  })

  return {
    commands,
    script,
    calls,
    posted,
    execs,
    requests,
    graphql: graphqlCalls,
    hold: prefix => {
      let open: () => void = () => {}
      const gate = new Promise<void>(resolve => { open = resolve })
      const held: Hold = { prefix, reached: false, gate, open }
      holds.push(held)
      return { reached: () => held.reached, release: () => held.open() }
    },
  }
}

export const issue = (repository: string, number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: number,
  number,
  title: `Issue ${number}`,
  state: 'open',
  body: '',
  user: { login: 'alice', type: 'User' },
  created_at: AT,
  updated_at: AT,
  html_url: `https://github.com/${repository}/issues/${number}`,
  ...overrides,
})

export const pull = (repository: string, number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...issue(repository, number),
  html_url: `https://github.com/${repository}/pull/${number}`,
  pull_request: { url: `https://api.github.com/repos/${repository}/pulls/${number}` },
  head: { sha: 'abc', ref: 'feature', repo: { full_name: repository } },
  merged: false,
  ...overrides,
})

export const comment = (repository: string, number: number, id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  body: 'comment',
  user: { login: 'carol', type: 'User' },
  html_url: `https://github.com/${repository}/issues/${number}#issuecomment-${id}`,
  created_at: AT,
  updated_at: AT,
  ...overrides,
})

export const notification = (repository: string, number: number, pr = false): Record<string, unknown> => ({
  repository: { full_name: repository },
  subject: { url: `https://api.github.com/repos/${repository}/${pr ? 'pulls' : 'issues'}/${number}` },
})

export interface Recording {
  host: SourceHost
  context: SourceContext
  registry: SourceRegistry
  board: HealthBoard
  received: { trigger: Trigger; result: ReceiveResult }[]
  state: Map<string, unknown>
  threads: Thread[]
  tickets: Map<string, Ticket>
  patches: { key: string; meta: Record<string, unknown> }[]
  closed: { thread: ThreadRef; outcome: string }[]
  logs: { level: string; event: string; fields?: Record<string, unknown> }[]
}

export function recordingHost(kind: SourceKind<any>): Recording {
  const board = new HealthBoard()
  const registry = new SourceRegistry(() => ({}), board)
  registry.register(kind)
  const received: Recording['received'] = []
  const state = new Map<string, unknown>()
  const threads: Thread[] = []
  const tickets = new Map<string, Ticket>()
  const patches: Recording['patches'] = []
  const closed: Recording['closed'] = []
  const logs: Recording['logs'] = []
  const report = registry.reporter(kind.kind)
  const context: SourceContext = {
    config: <C extends Record<string, unknown>>(id: string): C | undefined => {
      const instance = registry.instance<C>(id)
      return instance?.enabled ? instance.config : undefined
    },
    receive: trigger => {
      const result: ReceiveResult = received.some(item => item.trigger.id === trigger.id) ? 'duplicate' : 'stored'
      received.push({ trigger, result })
      return result
    },
    atomic: work => work(),
    state: {
      get: name => state.get(name) as never,
      set: (name, value) => { if (value === undefined) state.delete(name); else state.set(name, value) },
      keys: family => [...state.keys()].filter(name => name.startsWith(family.prefix)) as never,
    },
    threads: {
      get: key => threads.find(thread => thread.key === key),
      subscribed: source => threads.filter(thread => thread.ref.source === source && thread.subscriptions.length > 0),
      describe: () => {},
      patch: (key, meta) => {
        patches.push({ key, meta })
        const thread = threads.find(item => item.key === key)
        if (!thread) return
        for (const [name, value] of Object.entries(meta)) {
          if (value === undefined) delete thread.meta[name]
          else thread.meta[name] = value
        }
      },
    },
    tickets: {
      get: id => tickets.get(id),
      open: () => [...tickets.values()].filter(ticket => !ticket.ended),
      bindThread: () => {},
      threadClosed: (thread, outcome) => { closed.push({ thread, outcome }) },
    },
    triggers: {
      get: id => received.find(item => item.trigger.id === id)?.trigger,
      latest: () => undefined,
    },
    notify: () => {},
    report,
    log: (level, event, fields) => { logs.push({ level, event, fields }) },
  }
  return {
    host: { sources: registry, context: () => context },
    context,
    registry,
    board,
    received,
    state,
    threads,
    tickets,
    patches,
    closed,
    logs,
  }
}
