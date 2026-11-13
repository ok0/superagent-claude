/** The subprocess runner: whitelisted environment, API-only variables, sanitized errors and the path root. */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CliError, Commands, commandError, type Exec, type Tally } from '../src/infra/commands.ts'
import { subprocessEnv } from '../src/infra/env.ts'
import { GitHubApi } from '../src/infra/github-api.ts'

const ok = () => vi.fn<Exec>(async () => ({ stdout: '{}' }))

describe('Commands', () => {
  it('passes only PATH, HOME, LANG and the named API variables to the API program, and no API variables to git', async () => {
    const exec = ok()
    const commands = new Commands({
      apiProgram: 'gh',
      baseEnv: {
        PATH: '/bin',
        HOME: '/h',
        LANG: 'C',
        ANTHROPIC_API_KEY: 'k',
        SUPERAGENT_CLAUDE_GITHUB_TOKEN: 't',
        AWS_SECRET_ACCESS_KEY: 's',
        GH_TOKEN: 'leak',
      },
      apiEnv: { GH_TOKEN: 't' },
      exec,
    })
    await commands.call(['api', 'user'])
    expect(exec.mock.calls[0]![2].env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C', GH_TOKEN: 't' })
    await commands.git(['status'], '/tmp')
    expect(exec.mock.calls[1]![2].env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C' })
  })

  it('subprocessEnv omits unset whitelist keys', () => {
    expect(subprocessEnv({ PATH: '/bin' }, { X: '1' })).toEqual({ PATH: '/bin', X: '1' })
  })

  it('prefixes API paths with the root and refuses escaping paths without running anything', async () => {
    const exec = ok()
    const commands = new Commands({ apiProgram: 'gh', baseEnv: {}, exec })
    await commands.at('repos/acme/widgets').api('issues/1')
    expect(exec.mock.calls[0]![1]).toEqual(['api', 'repos/acme/widgets/issues/1'])
    exec.mockClear()
    for (const path of ['../x', '/user', 'https://evil', 'issues/../../x']) {
      await expect(commands.at('repos/acme/widgets').api(path)).rejects.toThrow('restricted')
    }
    expect(exec).not.toHaveBeenCalled()
  })

  it('turns failures into CliError with the HTTP status and without argv', async () => {
    const httpFailure = Object.assign(new Error('failed'), { stderr: 'gh: Not Found (HTTP 404)', code: 1 })
    const failing = new Commands({
      apiProgram: 'gh',
      baseEnv: {},
      exec: vi.fn(async () => {
        throw httpFailure
      }),
    })
    const error = await failing.call(['api', 'x', '-f', 'body=secret-body']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe(404)
    expect((error as Error).message).not.toContain('secret-body')

    const jsonFailure = Object.assign(new Error('failed'), {
      stderr: '{"error":{"code":410,"message":"Gone"}}',
      code: 1,
    })
    const gone = new Commands({
      apiProgram: 'gh',
      baseEnv: {},
      exec: vi.fn(async () => {
        throw jsonFailure
      }),
    })
    const goneError = await gone.call(['api', 'x']).catch((caught: unknown) => caught)
    expect((goneError as CliError).code).toBe(410)

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const aborted = new Commands({
      apiProgram: 'gh',
      baseEnv: {},
      exec: vi.fn(async () => {
        throw abort
      }),
    })
    await expect(aborted.call(['api', 'x'])).rejects.toBe(abort)
  })

  it('reads all pages and skips invalid items', async () => {
    const exec = vi.fn<Exec>(async () => ({ stdout: JSON.stringify([[{ id: 1 }, { id: 'x' }], [{ id: 2 }]]) }))
    const commands = new Commands({ apiProgram: 'gh', baseEnv: {}, exec })
    const tally: Tally = { skipped: 0 }
    const items = await commands.pages(z.object({ id: z.number() }), 'issues', tally)
    expect(items).toEqual([{ id: 1 }, { id: 2 }])
    expect(tally.skipped).toBe(1)
    const args = exec.mock.calls[0]![1]
    expect(args.slice(-2)).toEqual(['--paginate', '--slurp'])
  })

  it('uses a per-call timeout for git and keeps the default otherwise', async () => {
    const exec = ok()
    const commands = new Commands({ apiProgram: 'gh', baseEnv: {}, exec })
    await commands.git(['status'], '/tmp')
    expect(exec.mock.calls[0]![2].timeout).toBe(90_000)
    await commands.git(['log'], '/tmp', {}, { timeoutMs: 10_000 })
    expect(exec.mock.calls[1]![2].timeout).toBe(10_000)
  })

  it('names the actual timeout in a timed-out error', () => {
    expect(
      commandError(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }), 'git', 10_000).message,
    ).toBe('git timed out after 10 s')
  })
})

function recorder(responder: (req: Request) => Response | Promise<Response>) {
  const seen: Request[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push(request.clone())
    return responder(request)
  }
  return { fetch, seen }
}

function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const hang: typeof globalThis.fetch = (_input, init) =>
  new Promise((_, reject) => {
    const signal = init?.signal
    const fail = (): void => reject(signal?.reason)
    if (signal?.aborted) fail()
    else signal?.addEventListener('abort', fail)
  })

describe('Commands GitHub API methods', () => {
  it('prefixes the root and sends typed JSON bodies', async () => {
    const r = recorder(req => (req.url.endsWith('/graphql') ? json(200, { data: { x: 1 } }) : json(200, { id: 1 })))
    const commands = new Commands({ baseEnv: {}, client: new GitHubApi({ token: 't', fetch: r.fetch }) }).at(
      'repos/acme/widgets',
    )
    await commands.get(z.looseObject({ id: z.number() }), 'issues/1')
    expect(r.seen[0]!.url).toBe('https://api.github.com/repos/acme/widgets/issues/1')
    expect(r.seen[0]!.method).toBe('GET')
    await commands.send(z.unknown(), 'POST', 'pulls', { draft: false, n: 2 })
    expect(await r.seen[1]!.json()).toEqual({ draft: false, n: 2 })
    const result = await commands.graphql(z.object({ x: z.number() }), 'query{x}', { number: 2 })
    expect(result).toEqual({ x: 1 })
    expect(r.seen[2]!.url).toBe('https://api.github.com/graphql')
    expect(await r.seen[2]!.json()).toEqual({ query: 'query{x}', variables: { number: 2 } })
  })

  it('list flattens pages and skips invalid items; listPages keeps page bodies; response exposes headers', async () => {
    const next = '<https://api.github.com/repos/acme/widgets/issues?page=2>; rel="next"'
    const r = recorder(req => {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/notifications')) return json(200, [], { 'x-poll-interval': '120' })
      if (url.searchParams.get('page') === '2') return json(200, [{ id: 2 }])
      return json(200, [{ id: 1 }, { bad: true }], { link: next })
    })
    const commands = new Commands({ baseEnv: {}, client: new GitHubApi({ token: 't', fetch: r.fetch }) }).at(
      'repos/acme/widgets',
    )
    const tally: Tally = { skipped: 0 }
    expect(await commands.list(z.object({ id: z.number() }), 'issues', tally)).toEqual([{ id: 1 }, { id: 2 }])
    expect(tally.skipped).toBe(1)
    expect(await commands.listPages(z.array(z.unknown()), 'issues')).toEqual([[{ id: 1 }, { bad: true }], [{ id: 2 }]])
    const response = await commands.response('notifications')
    expect(response.headers['x-poll-interval']).toBe('120')
    expect(response.status).toBe(200)
  })

  it('new methods refuse escaping paths and braces without a request', async () => {
    const r = recorder(() => json(200, {}))
    const commands = new Commands({ baseEnv: {}, client: new GitHubApi({ token: 't', fetch: r.fetch }) }).at(
      'repos/acme/widgets',
    )
    for (const p of ['../x', 'issues/../../x', '/user', 'https://evil', 'issues/{owner}', 'issues/1}']) {
      await expect(commands.get(z.unknown(), p)).rejects.toThrow(/restricted to the configured root/)
      await expect(commands.send(z.unknown(), 'POST', p, {})).rejects.toThrow(/restricted to the configured root/)
      await expect(commands.response(p)).rejects.toThrow(/restricted to the configured root/)
      await expect(commands.list(z.unknown(), p)).rejects.toThrow(/restricted to the configured root/)
      await expect(commands.listPages(z.unknown(), p)).rejects.toThrow(/restricted to the configured root/)
    }
    expect(r.seen.length).toBe(0)
  })

  it('without an API client every new method fails with API client is not configured', async () => {
    const commands = new Commands({ baseEnv: {} }).at('repos/acme/widgets')
    const message = /API client is not configured/
    await expect(commands.get(z.unknown(), 'issues/1')).rejects.toThrow(message)
    await expect(commands.send(z.unknown(), 'POST', 'issues/1', {})).rejects.toThrow(message)
    await expect(commands.response('issues/1')).rejects.toThrow(message)
    await expect(commands.list(z.unknown(), 'issues/1')).rejects.toThrow(message)
    await expect(commands.listPages(z.unknown(), 'issues/1')).rejects.toThrow(message)
    await expect(commands.graphql(z.unknown(), 'query{x}', {})).rejects.toThrow(message)
  })

  it('withSignal carries the abort signal to the API methods', async () => {
    const commands = new Commands({ baseEnv: {}, client: new GitHubApi({ token: 't', fetch: hang }) }).at(
      'repos/acme/widgets',
    )
    const runs: ((c: Commands) => Promise<unknown>)[] = [
      c => c.get(z.unknown(), 'user'),
      c => c.list(z.unknown(), 'repos/a/b/issues'),
      c => c.graphql(z.unknown(), 'query{x}', {}),
    ]
    for (const run of runs) {
      const ctl = new AbortController()
      const pending = run(commands.withSignal(ctl.signal))
      ctl.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    }
  })
})
