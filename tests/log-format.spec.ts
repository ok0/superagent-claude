/**
 * --log-format text|json: json writes only JSON lines on stdout and nothing on stderr, text keeps
 * today's output, secrets become [redacted].
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli/main.ts'
import { logFormat } from '../src/cli/log-format.ts'
import { UNSANDBOXED_WARNING } from '../src/app/credentials.ts'
import { jsonLines } from '../src/app/runtime.ts'
import { waitUntil } from './fixtures/async.ts'
import { cliEnv, cliIo } from './fixtures/cli.ts'
import { fileGh, type FileGh } from './fixtures/file-gh.ts'

const SECRET = 'secret-value-1234567890'
const dirs: string[] = []
const children: ChildProcess[] = []
const githubs = new Map<string, FileGh>()

afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  githubs.clear()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'log-format-'))
  dirs.push(dir)
  return dir
}

function writeConfig(dir: string, extra: Record<string, unknown> = {}): string {
  const path = join(dir, 'issuecrew.json')
  writeFileSync(
    path,
    JSON.stringify({
      repositories: ['owner/repo'],
      policy: { allowed: ['alice'] },
      security: { allowUnsandboxed: true },
      stateDir: join(dir, 'state'),
      ...extra,
    }),
  )
  return path
}

function secretEnv(dir: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const inherited: Record<string, string | undefined> = { ...process.env }
  delete inherited.ISSUECREW_LOG_FORMAT
  const env: Record<string, string | undefined> = {
    ...inherited,
    ...cliEnv(dir, { ISSUECREW_GITHUB_TOKEN: SECRET, ...extra }),
  }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  return env
}

function spawnCli(args: string[], dir: string, extra: Record<string, string | undefined> = {}) {
  const entry = process.env.ISSUECREW_CLI ?? fileURLToPath(new URL('../src/cli/bin.ts', import.meta.url))
  const gh = githubs.get(dir) ?? fileGh(dir, { repositories: { 'owner/repo': {}, 'owner/other': {} } })
  githubs.set(dir, gh)
  const child = spawn(process.execPath, [entry, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...secretEnv(dir, extra), ...gh.env } as NodeJS.ProcessEnv,
  })
  children.push(child)
  const state = {
    out: '',
    err: '',
    code: undefined as number | null | undefined,
    signal: undefined as NodeJS.Signals | null | undefined,
  }
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    state.out += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    state.err += chunk
  })
  child.once('exit', (code, signal) => {
    state.code = code
    state.signal = signal
  })
  return { child, state }
}

async function runDaemon(args: string[], dir: string, extra: Record<string, string | undefined> = {}) {
  const run = spawnCli(args, dir, extra)
  await waitUntil(() => run.state.out.includes('"runtime.started"'), 15_000)
  run.child.kill('SIGTERM')
  await waitUntil(() => run.state.code !== undefined, 15_000)
  return run.state
}

function jsonOnly(text: string): boolean {
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .every(line => {
      try {
        JSON.parse(line)
        return true
      } catch {
        return false
      }
    })
}

function records(text: string): { event: string; detail?: string }[] {
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as { event: string; detail?: string })
}

describe('log format', () => {
  it('chooses the format from the flag, then the env, else text', () => {
    expect(logFormat([], {})).toBe('text')
    expect(logFormat(['--log-format', 'json'], {})).toBe('json')
    expect(logFormat([], { ISSUECREW_LOG_FORMAT: 'json' })).toBe('json')
    expect(logFormat(['--log-format', 'text'], { ISSUECREW_LOG_FORMAT: 'json' })).toBe('text')
    expect(logFormat([], { ISSUECREW_LOG_FORMAT: '' })).toBe('text')
    expect(logFormat(['--log-format', 'yaml'], {})).toBeUndefined()
    expect(logFormat(['--log-format'], {})).toBeUndefined()
    expect(logFormat(['--config', '--log-format'], {})).toBe('text')
  })

  it('the log sink replaces secret values and token shapes with [redacted]', () => {
    const lines: string[] = []
    const log = jsonLines(
      line => {
        lines.push(line)
      },
      { ISSUECREW_GITHUB_TOKEN: SECRET },
    )
    log({ level: 'info', at: 'x', event: 'e', detail: `a ${SECRET} b ghp_${'a'.repeat(20)} c` } as Parameters<
      typeof log
    >[0])
    expect(lines).toHaveLength(1)
    expect((JSON.parse(lines[0]!) as { detail: string }).detail).toBe('a [redacted] b [redacted] c')
  })

  it('json: a refused start is one JSON line on stdout, nothing on stderr, and the secret is redacted', async () => {
    const dir = tempDir()
    const c = cliIo(dir, secretEnv(dir))
    const code = await main(
      ['start', '--fake', '--log-format', 'json', '--config', join(dir, `missing-${SECRET}.json`)],
      c.io,
    )
    expect(code).toBe(2)
    expect(c.err.join('')).toBe('')
    const out = c.out.join('')
    expect(jsonOnly(out)).toBe(true)
    const lines = records(out)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.event).toBe('cli.refused')
    expect(lines[0]!.detail).toContain('[redacted]')
    expect(out).not.toContain(SECRET)
  })

  it('json: an unknown option is refused on stdout without the help text', async () => {
    const dir = tempDir()
    const c = cliIo(dir, secretEnv(dir))
    const code = await main(['start', '--bogus', '--log-format', 'json'], c.io)
    expect(code).toBe(2)
    expect(c.err.join('')).toBe('')
    const out = c.out.join('')
    const lines = records(out)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.event).toBe('cli.refused')
    expect(out).not.toContain('Usage:')
  })

  it('an invalid format is refused on stderr', async () => {
    const dir = tempDir()
    const c = cliIo(dir, secretEnv(dir))
    const code = await main(['start', '--log-format', 'yaml'], c.io)
    expect(code).toBe(2)
    expect(c.err.join('')).toContain('take text or json')
  })

  it('json: the daemon writes only JSON lines on stdout and nothing on stderr, warnings included', async () => {
    const dir = tempDir()
    const cfg = writeConfig(dir)
    const state = await runDaemon(['start', '--fake', '--log-format', 'json', '--config', cfg], dir)
    expect(state.code).toBe(0)
    expect(state.err).toBe('')
    expect(jsonOnly(state.out)).toBe(true)
    const events = records(state.out).map(record => record.event)
    expect(events).toContain('startup.warning')
    expect(events).toContain('runtime.stopped')
    expect(state.out).not.toContain(SECRET)
    expect(state.out).not.toContain('test-key')

    const text = await runDaemon(['start', '--fake', '--config', cfg], dir)
    if (text.err.includes('ExperimentalWarning')) {
      expect(
        records(state.out).some(
          record => record.event === 'node.warning' && record.detail?.includes('ExperimentalWarning'),
        ),
      ).toBe(true)
    }
  }, 60_000)

  it('the env variable selects json as well', async () => {
    const dir = tempDir()
    const state = await runDaemon(['start', '--fake', '--config', writeConfig(dir)], dir, {
      ISSUECREW_LOG_FORMAT: 'json',
    })
    expect(state.err).toBe('')
    expect(jsonOnly(state.out)).toBe(true)
    expect(records(state.out).map(record => record.event)).toContain('startup.warning')
  }, 60_000)

  it('text: stdout keeps the JSON events and stderr keeps the plain-text warning', async () => {
    const dir = tempDir()
    const state = await runDaemon(['start', '--fake', '--config', writeConfig(dir)], dir)
    expect(state.code).toBe(0)
    expect(state.err).toContain(`issuecrew: warning: ${UNSANDBOXED_WARNING}\n`)
    expect(jsonOnly(state.out)).toBe(true)
    expect(records(state.out).map(record => record.event)).not.toContain('startup.warning')
    expect(state.out).not.toContain(SECRET)
  }, 60_000)
})
