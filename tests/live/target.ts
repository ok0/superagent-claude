export type LiveEnv = Readonly<Record<string, string | undefined>>

export const LIVE_TARGET_ENV = {
  repo: 'SUPERAGENT_CLAUDE_LIVE_REPO',
  reportRepo: 'SUPERAGENT_CLAUDE_LIVE_REPORT_REPO',
  ownerLogin: 'SUPERAGENT_CLAUDE_LIVE_OWNER_LOGIN',
  agentLogin: 'SUPERAGENT_CLAUDE_LIVE_AGENT_LOGIN',
} as const

export const TARGET_NOT_CONFIGURED = 'live target not configured'
export const TARGET_SKIP_LINE = 'skipped: SUPERAGENT_CLAUDE_LIVE_REPO is not set'

export interface LiveTarget {
  repo: string
  owner: string
  name: string
  ownerLogin: string
  agentLogin: string
  reportRepo?: string
}

export class LiveTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LiveTargetError'
  }
}

const REPO_FORMAT = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const LOGIN_FORMAT = /^[A-Za-z0-9-]+$/

function login(env: LiveEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') throw new LiveTargetError(name + ' is required when SUPERAGENT_CLAUDE_LIVE_REPO is set')
  if (!LOGIN_FORMAT.test(value)) throw new LiveTargetError(name + ' must be a GitHub login: ' + JSON.stringify(value))
  return value
}

export function liveTarget(env: LiveEnv = process.env): LiveTarget | null {
  const repo = env.SUPERAGENT_CLAUDE_LIVE_REPO
  if (repo === undefined || repo.trim() === '') return null
  if (!REPO_FORMAT.test(repo)) throw new LiveTargetError('SUPERAGENT_CLAUDE_LIVE_REPO must be owner/name: ' + JSON.stringify(repo))
  const ownerLogin = login(env, 'SUPERAGENT_CLAUDE_LIVE_OWNER_LOGIN')
  const agentLogin = login(env, 'SUPERAGENT_CLAUDE_LIVE_AGENT_LOGIN')
  const reportRaw = env.SUPERAGENT_CLAUDE_LIVE_REPORT_REPO
  const report = reportRaw === undefined || reportRaw.trim() === '' ? undefined : reportRaw
  if (report !== undefined) {
    if (!REPO_FORMAT.test(report)) throw new LiveTargetError('SUPERAGENT_CLAUDE_LIVE_REPORT_REPO must be owner/name: ' + JSON.stringify(report))
    if (report.toLowerCase() === repo.toLowerCase()) throw new LiveTargetError('SUPERAGENT_CLAUDE_LIVE_REPORT_REPO must differ from SUPERAGENT_CLAUDE_LIVE_REPO: ' + JSON.stringify(report))
  }
  return {
    repo,
    owner: repo.split('/')[0] ?? '',
    name: repo.split('/')[1] ?? '',
    ownerLogin,
    agentLogin,
    ...(report !== undefined ? { reportRepo: report } : {}),
  }
}

export function requireLiveTarget(env: LiveEnv = process.env): LiveTarget {
  const target = liveTarget(env)
  if (target === null) throw new Error(TARGET_NOT_CONFIGURED)
  return target
}

export function liveEnabled(env: LiveEnv = process.env): boolean {
  return env.SUPERAGENT_CLAUDE_LIVE === '1' && liveTarget(env) !== null
}

export function renderLiveText(text: string, target: LiveTarget): string {
  const rendered = text
    .replaceAll('{{agent}}', target.agentLogin)
    .replaceAll('{{owner}}', target.ownerLogin)
    .replaceAll('{{repo}}', target.repo)
  const unknown = /\{\{[^{}]*\}\}/.exec(rendered)
  if (unknown) throw new Error('unknown placeholder in live text: ' + unknown[0])
  return rendered
}
