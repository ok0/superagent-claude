/**
 * CLI test fixtures: an in-process fake GitHub fetch, the environment that starts the daemon, and a CliIo that records
 * output and signal listeners.
 * The first cliEnv call in a test file installs the default fake GitHub fetch. A per-test installFakeFetch must be
 * called after the file's first cliEnv so that its restore returns to the default fake.
 */
import type { CliIo } from '../../src/cli/main.ts'

let defaultInstalled = false

export function installFakeFetch(
  options: { login?: string; failUser?: boolean; inaccessible?: readonly string[]; hang?: boolean } = {},
): { requests: string[]; restore(): void } {
  const previous = globalThis.fetch
  const requests: string[] = []
  const json = (status: number, data: unknown): Response =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.host !== 'api.github.com') return previous(input, init)
    const path = url.pathname.replace(/^\//, '')
    requests.push(request.method + ' ' + path)
    if (options.hang) {
      const signal = init?.signal ?? request.signal
      return new Promise<Response>((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    if (path === 'user') {
      return options.failUser
        ? json(401, { message: 'Bad credentials' })
        : json(200, { login: options.login ?? 'agent-bot', id: 1, type: 'User' })
    }
    const repo = /^repos\/([^/]+\/[^/]+)$/.exec(path)
    if (repo && (options.inaccessible ?? []).includes(repo[1]!)) return json(404, { message: 'Not Found' })
    if (/^repos\/[^/]+\/[^/]+\/.+/.test(path)) return json(200, [])
    if (repo) return json(200, { full_name: repo[1], permissions: { push: true } })
    return json(200, [])
  }
  return {
    requests,
    restore: () => {
      globalThis.fetch = previous
    },
  }
}

export function cliEnv(
  dir: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  if (!defaultInstalled) {
    defaultInstalled = true
    installFakeFetch()
  }
  const env: Record<string, string | undefined> = {
    HOME: '/home/test',
    PATH: '/usr/bin:/bin',
    SUPERAGENT_CLAUDE_GITHUB_TOKEN: 'test-token',
    ANTHROPIC_API_KEY: 'test-key',
    ...extra,
  }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  return env
}

export function cliIo(cwd: string, env: Record<string, string | undefined>) {
  const out: string[] = []
  const err: string[] = []
  const listeners: Partial<Record<'SIGINT' | 'SIGTERM' | 'SIGHUP', () => void>> = {}
  const io: CliIo = {
    out: s => {
      out.push(s)
    },
    err: s => {
      err.push(s)
    },
    cwd,
    env,
    signals: {
      once: (signal, listener) => {
        listeners[signal] = listener
      },
      on: (signal, listener) => {
        listeners[signal] = listener
      },
      off: signal => {
        delete listeners[signal]
      },
    },
  }
  return { io, out, err, listeners }
}
