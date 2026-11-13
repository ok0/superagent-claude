import { describe, expect, it } from 'vitest'
import { Octokit } from '@octokit/core'
import { CliError } from '../src/infra/commands.ts'
import { GitHubApi, apiError } from '../src/infra/github-api.ts'

const TOKEN = 'sentinel-token-7f3a'
const BODY = 'sentinel-body-91c2'
const PATH_SENTINEL = 'sentinel-path-55'

function recorder(responder: (req: Request) => Response | Promise<Response>) {
  const seen: Request[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const r = new Request(input, init)
    seen.push(r.clone())
    return responder(r)
  }
  return { fetch, seen }
}

function at(seen: Request[], i: number): Request {
  return seen[i] as Request
}

function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function notModified(data: unknown): Response {
  return Object.defineProperty(json(200, data), 'status', { value: 304 })
}

function leaks(err: unknown): string[] {
  const e = err as Error & { cause?: unknown }
  return [e.message, JSON.stringify({ ...e }), String(e.cause ?? '')]
}

function assertClean(err: unknown, extra: string[] = []): void {
  const text = leaks(err).join('\n')
  for (const s of [TOKEN, BODY, PATH_SENTINEL, 'api.github.com', ...extra]) expect(text).not.toContain(s)
  expect('cause' in (err as object)).toBe(false)
}

const hang: typeof globalThis.fetch = (_input, init) =>
  new Promise((_, reject) => {
    const signal = init?.signal
    const fail = (): void => reject(signal?.reason)
    if (signal?.aborted) fail()
    else signal?.addEventListener('abort', fail)
  })

describe('GitHubApi', () => {
  it('sends token auth and the superagent-claude user agent', async () => {
    const r = recorder(() => json(200, {}))
    await new GitHubApi({ token: TOKEN, fetch: r.fetch }).request('GET', 'user')
    expect(at(r.seen, 0).headers.get('authorization')).toContain(TOKEN)
    expect(at(r.seen, 0).headers.get('user-agent')).toContain('superagent-claude')
    expect(at(r.seen, 0).url).toBe('https://api.github.com/user')
  })

  it('keeps JSON body types on POST and PATCH', async () => {
    const r = recorder(() => json(200, {}))
    const api = new GitHubApi({ token: TOKEN, fetch: r.fetch })
    await api.request('POST', 'repos/a/b/pulls', { title: 't', draft: false })
    const post = (await at(r.seen, 0).json()) as { title: string; draft: unknown }
    expect(post).toEqual({ title: 't', draft: false })
    expect(typeof post.draft).toBe('boolean')
    expect(at(r.seen, 0).headers.get('content-type')).toContain('application/json')

    await api.request('PATCH', 'repos/a/b/pulls/2', { state: 'closed' })
    expect(at(r.seen, 1).method).toBe('PATCH')
    expect(await at(r.seen, 1).json()).toEqual({ state: 'closed' })

    await api.graphql('query($number:Int!){x}', { number: 7 })
    expect(at(r.seen, 2).method).toBe('POST')
    expect(new URL(at(r.seen, 2).url).pathname).toBe('/graphql')
    const gql = (await at(r.seen, 2).json()) as { query: string; variables: { number: unknown } }
    expect(gql).toEqual({ query: 'query($number:Int!){x}', variables: { number: 7 } })
    expect(Number.isInteger(gql.variables.number)).toBe(true)
  })

  it('follows link rel=next across three pages in order', async () => {
    const r = recorder(req => {
      const page = Number(new URL(req.url).searchParams.get('page') ?? '1')
      return page === 3
        ? json(200, [3])
        : json(200, [page], { link: `<https://api.github.com/x?page=${page + 1}>; rel="next"` })
    })
    const pages = await new GitHubApi({ token: TOKEN, fetch: r.fetch }).pages('x')
    expect(pages).toEqual([[1], [2], [3]])
    expect(r.seen.map(q => q.url)).toEqual([
      'https://api.github.com/x',
      'https://api.github.com/x?page=2',
      'https://api.github.com/x?page=3',
    ])
  })

  it('refuses a cross-origin next link', async () => {
    const r = recorder(() => json(200, [1], { link: '<https://evil.example/x?page=2>; rel="next"' }))
    const err = (await new GitHubApi({ token: TOKEN, fetch: r.fetch }).pages('x').catch((e: unknown) => e)) as CliError
    expect(err).toBeInstanceOf(CliError)
    expect(r.seen.filter(q => new URL(q.url).host === 'evil.example')).toHaveLength(0)
    assertClean(err, ['evil.example'])
  })

  it('graphql returns only data and accepts a variable named method', async () => {
    const r = recorder(() => json(200, { data: { ok: true } }))
    const result = await new GitHubApi({ token: TOKEN, fetch: r.fetch }).graphql(
      'mutation($method:PullRequestMergeMethod!){x}',
      { id: 'PR_1', method: 'SQUASH' },
    )
    expect(result).toEqual({ ok: true })
    const body = (await at(r.seen, 0).json()) as { variables: { method: string } }
    expect(body.variables.method).toBe('SQUASH')
  })

  it('graphql errors throw the first message', async () => {
    const r = recorder(() => json(200, { errors: [{ message: 'first' }, { message: 'second' }] }))
    const err = (await new GitHubApi({ token: TOKEN, fetch: r.fetch })
      .graphql('query{x}', {})
      .catch((e: unknown) => e)) as CliError
    expect(err).toBeInstanceOf(CliError)
    expect(err.message).toBe('first')
    expect(err.code).toBeUndefined()
  })

  it.each([
    [404, 'Not Found'],
    [410, 'Gone'],
    [304, 'Moved'],
  ])('maps %i to CliError with the status', async (status, message) => {
    const r = recorder(() => (status === 304 ? notModified({ message }) : json(status, { message })))
    const err = (await new GitHubApi({ token: TOKEN, fetch: r.fetch })
      .request('POST', `repos/a/b/${PATH_SENTINEL}`, { body: BODY })
      .catch((e: unknown) => e)) as CliError
    expect(err).toBeInstanceOf(CliError)
    expect(err.code).toBe(status)
    expect(err.message).toContain(message)
    assertClean(err)
  })

  it('maps a network failure without leaking', async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED ' + 'api.github.com'), { code: 'ECONNREFUSED' }),
      })
    }
    const err = (await new GitHubApi({ token: TOKEN, fetch })
      .request('GET', 'user')
      .catch((e: unknown) => e)) as CliError
    expect(err).toBeInstanceOf(CliError)
    expect(err.message).toBe('GitHub API request failed: ECONNREFUSED')
    assertClean(err)
  })

  it('times out with a CliError', async () => {
    const err = (await new GitHubApi({ token: TOKEN, fetch: hang, timeoutMs: 30 })
      .request('GET', 'user')
      .catch((e: unknown) => e)) as CliError
    expect(err).toBeInstanceOf(CliError)
    expect(err.message).toMatch(/timed out/)
    assertClean(err)
  })

  it('passes a caller abort through as AbortError', async () => {
    const ac = new AbortController()
    const pending = new GitHubApi({ token: TOKEN, fetch: hang })
      .request('GET', 'user', undefined, ac.signal)
      .catch((e: unknown) => e)
    setTimeout(() => ac.abort(), 10)
    const err = await pending
    expect(err).toMatchObject({ name: 'AbortError' })
  })

  it('Octokit resolves globalThis.fetch at request time', async () => {
    const api = new GitHubApi({ token: TOKEN })
    const r = recorder(() => json(200, {}))
    const previous = globalThis.fetch
    globalThis.fetch = r.fetch
    try {
      await api.request('GET', 'user')
    } finally {
      globalThis.fetch = previous
    }
    expect(r.seen.length).toBe(1)
  })

  it('passes a query string through unchanged', async () => {
    const paths = [
      'repos/a/b/notifications?all=true&per_page=50&since=2026-09-23T00%3A00%3A00.000Z',
      'pulls?state=open&head=a:feature&per_page=10',
    ]
    const r = recorder(() => json(200, []))
    const api = new GitHubApi({ token: TOKEN, fetch: r.fetch })
    for (const p of paths) await api.request('GET', p)
    expect(r.seen.map(q => q.url)).toEqual(paths.map(p => 'https://api.github.com/' + p))
  })

  it('RequestError shape consumed by the mapping', async () => {
    const r = recorder(req => Object.defineProperty(json(410, { message: 'Gone' }), 'url', { value: req.url }))
    const octokit = new Octokit({ auth: TOKEN, request: { fetch: r.fetch } })
    const e = (await octokit
      .request({ method: 'POST', url: '/repos/a/b/' + PATH_SENTINEL, data: { body: BODY } })
      .catch((x: unknown) => x)) as {
      name: string
      status: number
      response: { data: { message: string }; url: string }
      request: { url: string; body: unknown; headers: { authorization: string } }
      cause?: unknown
    }
    expect(e.name).toBe('HttpError')
    expect(e.status).toBe(410)
    expect(e.response.data.message).toBe('Gone')
    expect(e.response.url).toContain(PATH_SENTINEL)
    expect(e.request.url).toContain(PATH_SENTINEL)
    expect(JSON.stringify(e.request.body)).toContain(BODY)
    expect(e.request.headers.authorization).not.toContain(TOKEN)
    const mapped = apiError(e)
    const expected = apiError({ name: 'HttpError', status: 410, response: { data: { message: 'Gone' } } })
    expect({ message: mapped.message, code: mapped.code }).toEqual({
      message: expected.message,
      code: expected.code,
    })

    const r304 = recorder(() => notModified({ message: 'Moved' }))
    const e304 = (await new Octokit({ auth: TOKEN, request: { fetch: r304.fetch } })
      .request({ method: 'GET', url: '/repos/a/b' })
      .catch((x: unknown) => x)) as { status: number; response: { data: { message: string } } }
    expect(e304.status).toBe(304)
    expect(e304.response.data.message).toBe('Moved')

    const original = new TypeError('fetch failed')
    const rNet = recorder(() => {
      throw original
    })
    const eNet = (await new Octokit({ auth: TOKEN, request: { fetch: rNet.fetch } })
      .request({ method: 'GET', url: '/repos/a/b' })
      .catch((x: unknown) => x)) as { status: number; response?: unknown; cause?: unknown }
    expect(eNet.status).toBe(500)
    expect(eNet.response).toBeUndefined()
    expect(eNet.cause).toBe(original)
  })
})
