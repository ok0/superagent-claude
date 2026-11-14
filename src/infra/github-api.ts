/** GitHub REST and GraphQL client over Octokit core: link pagination on one origin, a per-request timeout, caller abort and CliError mapping that never carries the token, request body or URL. */
import { Octokit } from '@octokit/core'
import { CliError, TIMEOUT_MS, type ApiClient, type ApiResponse } from './commands.ts'

export type { ApiResponse }

export const API_BASE = 'https://api.github.com'

export interface GitHubApiOptions {
  token: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

type Obj = Record<string, unknown>

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null

const codeOf = (v: unknown): unknown => (isObject(v) ? v.code : undefined)

export function apiError(error: unknown): CliError {
  if (
    isObject(error) &&
    error.name === 'HttpError' &&
    typeof error.status === 'number' &&
    error.response !== undefined
  ) {
    const status = error.status
    const data = isObject(error.response) ? error.response.data : undefined
    const msg = isObject(data) && typeof data.message === 'string' ? data.message : 'HTTP ' + status
    return new CliError(`${msg} (${status})`.slice(0, 2000), status)
  }
  const cause = isObject(error) ? error.cause : undefined
  const raw = (isObject(cause) ? codeOf(cause.cause) : undefined) ?? codeOf(cause)
  const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]*$/.test(raw) ? raw : undefined
  return new CliError('GitHub API request failed' + (code ? ': ' + code : ''))
}

export class GitHubApi implements ApiClient {
  private readonly octokit: Octokit
  private readonly timeoutMs: number

  constructor(options: GitHubApiOptions) {
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS
    this.octokit = new Octokit({
      auth: options.token,
      userAgent: 'issuecrew',
      request: options.fetch ? { fetch: options.fetch } : {},
    })
  }

  request(method: string, path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<ApiResponse> {
    return this.send(method, '/' + path, body, signal)
  }

  async pages(path: string, signal?: AbortSignal): Promise<unknown[]> {
    const out: unknown[] = []
    let url = '/' + path
    for (;;) {
      const res = await this.send('GET', url, undefined, signal)
      out.push(res.data)
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.link ?? '')?.[1]
      if (!next) return out
      if (new URL(next).origin !== new URL(API_BASE).origin) {
        throw new CliError('GitHub API pagination left the API origin')
      }
      url = next
    }
  }

  async graphql(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const res = await this.send('POST', '/graphql', { query, variables }, signal)
    const body = res.data as { data?: unknown; errors?: { message?: unknown }[] }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const message = body.errors[0]?.message
      throw new CliError(typeof message === 'string' ? message : 'GitHub GraphQL request failed')
    }
    return body.data
  }

  private async send(
    method: string,
    url: string,
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<ApiResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const params: Record<string, string> = {}
    const safeUrl = url.replace(/[:{}]/g, c => {
      const k = 'c' + c.charCodeAt(0)
      params[k] = c
      return '{+' + k + '}'
    })
    let res
    try {
      res = await this.octokit.request({
        method,
        url: safeUrl,
        ...params,
        ...(body === undefined ? {} : { data: body }),
        request: { signal: combined },
      } as never)
    } catch (error) {
      if (signal?.aborted) {
        throw error instanceof Error && error.name === 'AbortError'
          ? error
          : new DOMException('This operation was aborted', 'AbortError')
      }
      if (timeout.aborted) throw new CliError(`GitHub API timed out after ${this.timeoutMs / 1000} s`)
      throw apiError(error)
    }
    return {
      status: res.status,
      headers: Object.fromEntries(
        Object.entries(res.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k.toLowerCase(), String(v)]])),
      ),
      data: res.data,
    }
  }
}
