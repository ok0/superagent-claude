// Ported from dsh-superagent-prototype (MIT) src/infra/commands.ts
/** Subprocess runner for the hosting API program and git, with timeouts, abort signals, sanitized errors and API paths confined to a root. Changes from the reference: the chat CLI runner and its error rewrite are removed; the API program, the inherited environment, the API-only variables and the process runner are injected options instead of a deployment; subprocesses get a whitelisted environment (subprocessEnv) instead of the daemon environment, and API-only variables reach only the API program; the repository restriction becomes a path root set by at; the JSON reader is call. */
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

/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
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
    // The API program exits non-zero on HTTP errors (such as "Not Found (HTTP 404)") and on HTTP 304, which conditional reads rely on.
    if (stderr)
      return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
}

function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}

export interface Tally {
  skipped: number
}

/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
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

export interface CommandsOptions {
  apiProgram: string
  baseEnv: Readonly<Record<string, string | undefined>>
  env?: Readonly<Record<string, string>>
  apiEnv?: Readonly<Record<string, string>>
  signal?: AbortSignal
  exec?: Exec
  root?: string
}

/**
 * Runs the hosting API program and git subprocesses with whitelisted environments, timeouts and abort signals.
 * API paths are confined to the root set by `at`, and failures become CliError instances without argv.
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
  ): Promise<string> {
    const env = subprocessEnv(this.options.baseEnv, { ...this.options.env, ...extra })
    try {
      const { stdout } = await (this.options.exec ?? execProgram)(program, args, {
        ...(cwd ? { cwd } : {}),
        env,
        ...(this.options.signal ? { signal: this.options.signal } : {}),
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      })
      return stdout
    } catch (error) {
      throw commandError(error, program)
    }
  }

  private runApi(args: string[]): Promise<string> {
    return this.run(this.options.apiProgram, args, undefined, this.options.apiEnv ?? {})
  }

  /** Runs the API program and parses its JSON output. */
  async call<T>(args: string[]): Promise<T> {
    return JSON.parse(await this.runApi(args)) as T
  }

  /**
   * Calls the hosting API on a path under the root, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with the HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.runApi(['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.call(['api', this.path(path), ...flags]))
  }

  /** Fetches all pages of an API list under the root, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z
      .array(z.array(z.unknown()))
      .parse(await this.call(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }

  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('API calls are restricted to the configured root')
    const root = this.root
    if (!root && !path) throw new Error('API calls are restricted to the configured root')
    return root ? (path ? `${root}/${path}` : root) : path
  }

  /** Runs `git` with the whitelisted environment only, without API-only variables; `extra` reaches only this call. */
  async git(args: string[], cwd: string, extra: Readonly<Record<string, string>> = {}): Promise<string> {
    return this.run('git', args, cwd, extra)
  }
}
