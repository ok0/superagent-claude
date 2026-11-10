import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli/main.ts'
import { STOP_TIMEOUT_MS } from '../src/app/runtime.ts'
import { waitUntil } from './fixtures/async.ts'
import { cliEnv, cliIo } from './fixtures/cli.ts'

const dirs: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-start-'))
  dirs.push(dir)
  return dir
}

function writeConfig(dir: string, extra: Record<string, unknown> = {}): string {
  const path = join(dir, 'superagent-claude.json')
  writeFileSync(path, JSON.stringify({ repositories: ['owner/repo'], policy: { allowed: ['alice'] }, stateDir: join(dir, 'state'), ...extra }))
  return path
}

function io(cwd: string) {
  return cliIo(cwd, cliEnv(cwd))
}

function spawnCli(args: string[], dir: string) {
  const entry = process.env.SUPERAGENT_CLAUDE_CLI ?? fileURLToPath(new URL('../src/cli/bin.ts', import.meta.url))
  const child = spawn(process.execPath, [entry, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...cliEnv(dir) } as NodeJS.ProcessEnv })
  children.push(child)
  const state = { out: '', err: '', code: undefined as number | null | undefined }
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { state.out += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { state.err += chunk })
  child.once('exit', code => { state.code = code })
  return { child, state }
}

function hasEvent(text: string, event: string): boolean {
  return text.split('\n').some(line => {
    try {
      return (JSON.parse(line) as { event?: unknown }).event === event
    } catch {
      return false
    }
  })
}

describe('start in process', () => {
  it('refuses a missing config file with exit code 2', async () => {
    const dir = tempDir()
    const c = io(dir)
    const code = await main(['start', '--config', join(dir, 'missing.json')], c.io)
    expect(code).toBe(2)
    expect(c.err.join('')).toContain('Config file not found')
  }, 30_000)

  it('refuses an invalid config with exit code 2', async () => {
    const dir = tempDir()
    const c = io(dir)
    const code = await main(['start', '--fake', '--config', writeConfig(dir, { repositories: [] })], c.io)
    expect(code).toBe(2)
    expect(c.err.join('')).toContain('repositories: must name at least one repository')
  }, 30_000)

  it('refuses an unknown start option with exit code 2', async () => {
    const dir = tempDir()
    const c = io(dir)
    const code = await main(['start', '--bogus'], c.io)
    expect(code).toBe(2)
    expect(c.err.join('')).toContain("unknown option '--bogus'")
  }, 30_000)

  it('start without --fake runs the Claude runtime and stops with exit code 0', async () => {
    const dir = tempDir()
    const c = io(dir)
    const p = main(['start', '--config', writeConfig(dir, { security: { allowUnsandboxed: true } })], c.io)
    await waitUntil(() => c.out.join('').includes('"runtime.started"'), 10_000)
    const started = c.out.join('').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as { event: string; runtime?: string }).find(record => record.event === 'runtime.started')
    expect(started?.runtime).toBe('claude')
    c.listeners.SIGINT!()
    expect(await p).toBe(0)
  }, 30_000)

  it('start --fake logs JSON and stops with exit code 0 on SIGINT', async () => {
    const dir = tempDir()
    const c = io(dir)
    const p = main(['start', '--fake', '--config', writeConfig(dir)], c.io)
    await waitUntil(() => c.out.join('').includes('"runtime.started"'), 10_000)
    c.listeners.SIGINT!()
    expect(await p).toBe(0)

    const lines = c.out.join('').split('\n').filter(line => line.length > 0)
    const events = lines.map(line => {
      const record = JSON.parse(line) as { level: unknown; at: unknown; event: string; runtime?: string }
      expect(record).toHaveProperty('level')
      expect(record).toHaveProperty('at')
      return record
    })
    expect(events.find(record => record.event === 'runtime.started')?.runtime).toBe('fake')
    expect(events.at(-1)?.event).toBe('runtime.stopped')
  }, 30_000)

  it('finds superagent-claude.json in the current directory', async () => {
    const dir = tempDir()
    writeConfig(dir)
    const c = io(dir)
    const p = main(['start', '--fake'], c.io)
    await waitUntil(() => c.out.join('').includes('"runtime.started"'), 10_000)
    c.listeners.SIGTERM!()
    expect(await p).toBe(0)
  }, 30_000)

  it('a SIGINT while the runtime starts stops it in order with exit code 0', async () => {
    const dir = tempDir()
    const bin = join(dir, 'slow-gh')
    mkdirSync(bin)
    const gh = join(bin, 'gh')
    writeFileSync(gh, '#!/bin/sh\nexec sleep 30\n')
    chmodSync(gh, 0o755)
    const c = cliIo(dir, cliEnv(dir, { PATH: `${bin}:/usr/bin:/bin` }))
    const p = main(['start', '--fake', '--config', writeConfig(dir)], c.io)
    await waitUntil(() => c.listeners.SIGINT !== undefined, 10_000)
    const at = Date.now()
    c.listeners.SIGINT!()
    expect(await p).toBe(0)
    expect(Date.now() - at).toBeLessThan(STOP_TIMEOUT_MS)
    const text = c.out.join('')
    expect(hasEvent(text, 'runtime.started')).toBe(false)
    expect(hasEvent(text, 'runtime.stopped')).toBe(true)
  }, 30_000)
})

describe('start as a child process', () => {
  it('the entry logs JSON on stdout, refuses a second daemon on the same stateDir with exit code 2, and exits 0 on SIGINT', async () => {
    const dir = tempDir()
    const cfg = writeConfig(dir)
    const first = spawnCli(['start', '--fake', '--config', cfg], dir)
    await waitUntil(() => hasEvent(first.state.out, 'runtime.started'), 15_000)

    const second = spawnCli(['start', '--fake', '--config', cfg], dir)
    await waitUntil(() => second.state.code !== undefined, 15_000)
    expect(second.state.code).toBe(2)
    expect(second.state.err).toContain('Another superagent-claude process')

    first.child.kill('SIGINT')
    await waitUntil(() => first.state.code !== undefined, 15_000)
    expect(first.state.code).toBe(0)
  }, 30_000)

  it('the entry exits 2 on an invalid config', async () => {
    const dir = tempDir()
    const child = spawnCli(['start', '--fake', '--config', writeConfig(dir, { policy: { allowed: [] } })], dir)
    await waitUntil(() => child.state.code !== undefined, 15_000)
    expect(child.state.code).toBe(2)
  }, 30_000)
})
