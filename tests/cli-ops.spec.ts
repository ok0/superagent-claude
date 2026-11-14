/**
 * The operator commands against a real process: status and needs answer while the daemon runs (with the
 * health snapshot it wrote), and the built entry runs both on a seeded state directory with exit 0 and no
 * token in the output.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { main } from '../src/cli/main.ts'
import { waitUntil } from './fixtures/async.ts'
import { cliEnv, cliIo } from './fixtures/cli.ts'
import { fileGh, type FileGh } from './fixtures/file-gh.ts'
import { seedState, TOKEN, writeStateConfig } from './fixtures/state.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'cli-ops-'))
  dirs.push(dir)
  return dir
}

function io(dir: string) {
  return cliIo(dir, cliEnv(dir))
}

function spawnCli(args: string[], dir: string) {
  const entry = process.env.ISSUECREW_CLI ?? fileURLToPath(new URL('../src/cli/bin.ts', import.meta.url))
  const gh = githubs.get(dir) ?? fileGh(dir, { repositories: { 'owner/repo': {}, 'owner/other': {} } })
  githubs.set(dir, gh)
  const child = spawn(process.execPath, [entry, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...cliEnv(dir), ...gh.env } as NodeJS.ProcessEnv,
  })
  children.push(child)
  const state = { out: '', err: '', code: undefined as number | null | undefined }
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    state.out += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    state.err += chunk
  })
  child.once('exit', code => {
    state.code = code
  })
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

it('status answers while start --fake runs, as README describes', async () => {
  const dir = tempDir()
  const configPath = writeStateConfig(dir)
  const daemon = spawnCli(['start', '--config', configPath, '--fake'], dir)
  await waitUntil(() => hasEvent(daemon.state.out, 'runtime.started'), 15_000)

  await vi.waitFor(
    async () => {
      const status = io(dir)
      expect(await main(['status', '--config', configPath], status.io)).toBe(0)
      expect(status.out.join('')).toContain('Daemon: running')
      expect(status.out.join('')).toContain('Health snapshot: 2')
    },
    { timeout: 15_000, interval: 200 },
  )

  const needs = io(dir)
  expect(await main(['needs', '--config', configPath], needs.io)).toBe(0)
  expect(needs.out.join('')).toBe('Nothing needs you.\n')

  daemon.child.kill('SIGTERM')
  await waitUntil(() => daemon.state.code !== undefined, 15_000)
  expect(daemon.state.code).toBe(0)
}, 30_000)

it('the command binary runs status and needs on the fixture state with exit 0', async () => {
  const dir = tempDir()
  const { store, configPath } = seedState(dir)
  store.close()

  const status = spawnCli(['status', '--config', configPath], dir)
  const needs = spawnCli(['needs', '--config', configPath], dir)
  await waitUntil(() => status.state.code !== undefined && needs.state.code !== undefined, 15_000)

  expect(status.state.code).toBe(0)
  expect(status.state.out).toContain('Running assignments (1):')
  expect(status.state.out).not.toContain(TOKEN)
  expect(needs.state.code).toBe(0)
  expect(needs.state.out).toContain('Grant push access')
  expect(needs.state.out).not.toContain(TOKEN)
}, 30_000)
