/** Child process tracking for the Claude runtime: the children file round trip, recording and removing spawned children, stopping only recorded Claude CLI children, and passing the tracking spawn to the SDK. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contractSpec } from './fixtures/runtime-contract.ts'
import { stubSdk } from './fixtures/claude-sdk-stub.ts'
import { ClaudeRuntime } from '../src/runtimes/claude/runtime.ts'
import { ChildRegistry, reapChildren, trackedSpawn } from '../src/runtimes/claude/children.ts'

let dir: string
let registry: ChildRegistry
const extra: ChildProcess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'children-'))
  registry = new ChildRegistry(join(dir, 'children.json'))
})

afterEach(() => {
  for (const child of extra.splice(0)) {
    try {
      child.kill()
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true })
})

const exited = (child: {
  once(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  )

describe('ChildRegistry', () => {
  it('round trips add and remove', () => {
    registry.add({ pid: 1, command: 'a' })
    registry.add({ pid: 2, command: 'b' })
    registry.remove(1)
    expect(registry.list()).toEqual([{ pid: 2, command: 'b' }])
  })

  it('returns an empty list for a missing file and for invalid JSON', () => {
    expect(registry.list()).toEqual([])
    writeFileSync(registry.file, '{not json')
    expect(registry.list()).toEqual([])
  })
})

describe('trackedSpawn', () => {
  it('records a spawned child and removes it when it exits', async () => {
    const child = trackedSpawn(registry)({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 300)'],
      env: { ...process.env },
      signal: new AbortController().signal,
    }) as ChildProcess
    extra.push(child)
    expect(registry.list()).toContainEqual({ pid: child.pid, command: process.execPath })
    await exited(child)
    await new Promise(resolve => setImmediate(resolve))
    expect(registry.list()).toEqual([])
  })

  it('forwards stderr to the callback', async () => {
    const chunks: string[] = []
    const child = trackedSpawn(registry, text => chunks.push(text))({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("x")'],
      env: { ...process.env },
      signal: new AbortController().signal,
    }) as ChildProcess
    extra.push(child)
    await exited(child)
    await new Promise(resolve => setImmediate(resolve))
    expect(chunks.join('')).toBe('x')
  })
})

describe('reapChildren', () => {
  it('stops a recorded child that still runs the Claude CLI', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'claude-cli-stub'])
    extra.push(child)
    const done = exited(child)
    registry.add({ pid: child.pid!, command: process.execPath })
    const stopped = await reapChildren(registry, { graceMs: 2000 })
    expect(stopped).toEqual([child.pid])
    expect((await done).signal).toBe('SIGTERM')
    expect(registry.list()).toEqual([])
  })

  it('kills a child that ignores SIGTERM after the grace period', async () => {
    const child = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
      'claude-cli-stub',
    ])
    extra.push(child)
    const done = exited(child)
    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()))
    registry.add({ pid: child.pid!, command: process.execPath })
    const stopped = await reapChildren(registry, { graceMs: 300 })
    expect(stopped).toEqual([child.pid])
    expect((await done).signal).toBe('SIGKILL')
  })

  it('leaves a recorded pid alone when another program runs under it', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    extra.push(child)
    registry.add({ pid: child.pid!, command: process.execPath })
    registry.add({ pid: child.pid!, command: '/usr/local/bin/claude' })
    const stopped = await reapChildren(registry, { graceMs: 300 })
    expect(stopped).toEqual([])
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
  })
})

describe('claude runtime children option', () => {
  it('passes the tracking spawn to the SDK when a children file is set', async () => {
    const sdk = stubSdk()
    const { spec } = contractSpec('followup starts a new turn')
    const runtime = new ClaudeRuntime({
      mode: 'api-key',
      configDir: dir,
      children: join(dir, 'children.json'),
      query: sdk.query,
      sandbox: false,
    })
    await runtime.open(spec)
    expect(typeof sdk.queries[0]!.options.spawnClaudeCodeProcess).toBe('function')
  })

  it('does not pass a spawn to the SDK without a children file', async () => {
    const sdk = stubSdk()
    const { spec } = contractSpec('followup starts a new turn')
    const runtime = new ClaudeRuntime({ mode: 'api-key', configDir: dir, query: sdk.query, sandbox: false })
    await runtime.open(spec)
    expect(sdk.queries[0]!.options.spawnClaudeCodeProcess).toBeUndefined()
  })
})
