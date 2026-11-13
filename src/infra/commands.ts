// Ported from dsh-superagent-prototype (MIT) src/infra/commands.ts
/** Runs git and calls the hosting API through the injected ApiClient, with timeouts, abort signals and sanitized errors. API paths are confined to a root; git gets a whitelisted environment. */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { subprocessEnv } from './env.ts'

export const TIMEOUT_MS = 90_000
const MAX_BUFFER = 16 * 1024 * 1024

export class CliError extends Error {
  readonly code: number | undefined
  readonly exitCode: number | undefined
  constructor(message: string, code?: number, exitCode?: number) {
    super(message)
    this.code = code
    this.exitCode = exitCode
  }
}

export interface CommandLimits {
  timeoutMs?: number
}

/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command', timeoutMs = TIMEOUT_MS): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try {
      parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed
    } catch {
      /* Non-JSON CLI diagnostics are retained below. */
    }
    const code = parsed?.error?.code
    if (parsed?.error?.message)
      return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // A program may exit non-zero with an HTTP status in stderr.
    if (stderr)
      return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error, timeoutMs)}`, undefined, exitCode)
}

function ended(error: unknown, timeoutMs: number): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${timeoutMs / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}

export interface Tally {
  skipped: number
}

export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => {
    const parsed = item.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
  if (tally) tally.skipped += list.length - items.length
  return items
}

export interface ExecOptions {
  cwd?: string
  env: Record<string, string>
  signal?: AbortSignal
  timeout: number
  maxBuffer: number
}

export type Exec = (program: string, args: readonly string[], options: ExecOptions) => Promise<{ stdout: string }>

export const execProgram: Exec = async (program, args, options) => {
  const { stdout } = await promisify(execFile)(program, [...args], { ...options, encoding: 'utf8' })
  return { stdout }
}

export interface ApiResponse {
  status: number
  headers: Readonly<Record<string, string>>
  data: unknown
}

export interface ApiClient {
  request(method: string, path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<ApiResponse>
  pages(path: string, signal?: AbortSignal): Promise<unknown[]>
  graphql(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

export interface CommandsOptions {
  baseEnv: Readonly<Record<string, string | undefined>>
  env?: Readonly<Record<string, string>>
  signal?: AbortSignal
  exec?: Exec
  root?: string
  client?: ApiClient
}

/**
 * Runs git with a whitelisted environment and routes hosting API calls through the injected ApiClient; API paths are confined to the root set by `at`, and failures become CliError instances without argv.
 */
export class Commands {
  private readonly options: CommandsOptions

  constructor(options: CommandsOptions) {
    this.options = options
  }

  get root(): string {
    return this.options.root ?? ''
  }

  withSignal(signal?: AbortSignal): Commands {
    if (!signal) return this
    return new Commands({
      ...this.options,
      signal: this.options.signal ? AbortSignal.any([this.options.signal, signal]) : signal,
    })
  }

  at(root: string): Commands {
    return new Commands({ ...this.options, root: root.replace(/\/+$/, '') })
  }

  async run(
    program: string,
    args: string[],
    cwd?: string,
    extra: Readonly<Record<string, string>> = {},
    limits: CommandLimits = {},
  ): Promise<string> {
    const env = subprocessEnv(this.options.baseEnv, { ...this.options.env, ...extra })
    const timeout = limits.timeoutMs ?? TIMEOUT_MS
    try {
      const { stdout } = await (this.options.exec ?? execProgram)(program, args, {
        ...(cwd ? { cwd } : {}),
        env,
        ...(this.options.signal ? { signal: this.options.signal } : {}),
        timeout,
        maxBuffer: MAX_BUFFER,
      })
      return stdout
    } catch (error) {
      throw commandError(error, program, timeout)
    }
  }

  private client(): ApiClient {
    if (!this.options.client) throw new Error('API client is not configured')
    return this.options.client
  }

  private apiPath(path: string): string {
    if (/[{}]/.test(path)) throw new Error('API calls are restricted to the configured root')
    return this.path(path)
  }

  async get<T>(schema: z.ZodType<T>, path: string): Promise<T> {
    const url = this.apiPath(path)
    const client = this.client()
    return schema.parse((await client.request('GET', url, undefined, this.options.signal)).data)
  }

  async send<T>(
    schema: z.ZodType<T>,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = this.apiPath(path)
    const client = this.client()
    return schema.parse((await client.request(method, url, body, this.options.signal)).data)
  }

  async response(path: string): Promise<ApiResponse> {
    const url = this.apiPath(path)
    const client = this.client()
    return client.request('GET', url, undefined, this.options.signal)
  }

  async listPages<T>(page: z.ZodType<T>, path: string): Promise<T[]> {
    const url = this.apiPath(path)
    const client = this.client()
    return z.array(page).parse(await client.pages(url, this.options.signal))
  }

  async list<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const url = this.apiPath(path)
    const client = this.client()
    const pages = z.array(z.array(z.unknown())).parse(await client.pages(url, this.options.signal))
    return validItems(item, pages.flat(), tally)
  }

  async graphql<T>(schema: z.ZodType<T>, query: string, variables: Record<string, unknown>): Promise<T> {
    const client = this.client()
    return schema.parse(await client.graphql(query, variables, this.options.signal))
  }

  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('API calls are restricted to the configured root')
    const root = this.root
    if (!root && !path) throw new Error('API calls are restricted to the configured root')
    return root ? (path ? `${root}/${path}` : root) : path
  }

  /** Runs `git` with the whitelisted environment only, without API-only variables; `extra` reaches only this call. */
  async git(
    args: string[],
    cwd: string,
    extra: Readonly<Record<string, string>> = {},
    limits: CommandLimits = {},
  ): Promise<string> {
    return this.run('git', args, cwd, extra, limits)
  }
}
