/** Router host tests: one session per prompt version, resume after close, idempotent inputs, and sandbox options. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentRuntime } from '../src/executor/contract.ts'
import { RouterHost, ROUTER_CONTEXT_NOTE, type RouterDeps, type RouterRecord } from '../src/executor/router-host.ts'
import type { PromptChange } from '../src/executor/worker-executor.ts'
import { ROUTER_TOOLS } from '../src/app/tool-names.ts'
import { tool } from '../src/app/tools/tool.ts'
import { FakeRuntime, type FakeScript } from '../src/runtimes/fake/runtime.ts'
import { sdkOptions, type OptionsContext } from '../src/runtimes/claude/options.ts'
import { waitUntil } from './fixtures/async.ts'

const dirs: string[] = []
const hosts: RouterHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const same = (): PromptChange => ({ kind: 'same' })

function make(
  script?: FakeScript,
  options: {
    promptChange?: (stored: string) => PromptChange
    record?: RouterRecord
    runtime?: (fake: FakeRuntime) => AgentRuntime
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'router-host-'))
  dirs.push(dir)
  const fake = new FakeRuntime(script ?? (() => undefined))
  const store: { value?: RouterRecord } = options.record ? { value: options.record } : {}
  const record = {
    get: () => store.value,
    put: vi.fn((next: RouterRecord) => {
      store.value = next
    }),
  }
  const deps: RouterDeps = {
    instructions: () => 'route',
    tools: () =>
      ROUTER_TOOLS.map(name =>
        tool({ name, description: name, schema: z.object({}).strict(), execute: async () => ({}) }),
      ),
    promptVersion: () => 'v1',
    promptChange: options.promptChange ?? same,
    record,
  }
  const host = new RouterHost({
    runtime: options.runtime ? options.runtime(fake) : fake,
    stateDir: dir,
    deps,
    limits: { maxTurns: 10, maxBudgetUsd: 1 },
  })
  hosts.push(host)
  return { dir, fake, host, record }
}

describe('RouterHost', () => {
  it('opens one router session with only the host tools', async () => {
    const { dir, fake, host } = make()
    await host.ensure()
    await host.ensure()
    expect(fake.opened).toHaveLength(1)
    const spec = fake.opened[0]!
    expect(spec.key).toBe('router')
    expect(spec.role).toBe('router')
    expect(spec.cwd).toBe(join(dir, 'router'))
    expect(existsSync(spec.cwd)).toBe(true)
    expect(readdirSync(spec.cwd)).toEqual([])
    expect(spec.builtins).toEqual({ fs: 'none', shell: false, web: false })
    expect(spec.network.allow).toEqual([])
    expect(spec.tools.map(t => t.name)).toEqual([...ROUTER_TOOLS])

    const ctx: OptionsContext = {
      mode: 'api-key',
      env: {},
      configDir: dir,
      sandbox: false,
      onRead: () => {},
      abortController: new AbortController(),
    }
    const options = sdkOptions(spec, ctx)
    for (const name of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Read', 'Glob', 'Grep']) {
      expect(options.disallowedTools).toContain(name)
    }
    for (const name of options.allowedTools ?? []) expect(name.startsWith('mcp__superagent__')).toBe(true)
    expect([...(options.allowedTools ?? [])].sort()).toEqual(ROUTER_TOOLS.map(n => 'mcp__superagent__' + n).sort())
    expect(options.systemPrompt).toBe('route')
  })

  it('notify waits for the next relay and ids are idempotent', async () => {
    const { fake, host } = make()
    await host.notify('n1', 'note')
    expect(fake.sessions[0]!.turns).toHaveLength(0)
    await host.relay('r1', 'hello')
    await waitUntil(() => fake.sessions[0]!.turns.length === 1)
    expect(fake.sessions[0]!.turns[0]!.inputs).toEqual(['n1', 'r1'])
    await host.relay('r1', 'hello')
    await host.notify('n1', 'note')
    expect(fake.sessions[0]!.sent).toHaveLength(2)
  })

  it('resumes the same session after it closes and resends what it had not read', async () => {
    const { fake, host, record } = make()
    await host.relay('r1', 'hello')
    await waitUntil(() => fake.sessions[0]!.turns.length === 1)
    await host.notify('n2', 'later')
    await fake.sessions[0]!.close()
    await waitUntil(() => fake.opened.length === 2)
    expect(fake.opened[1]!.resume).toBe(fake.sessions[0]!.sessionId)
    await waitUntil(() => fake.sessions[1]!.sent.some(input => input.id === 'n2' && input.mode === 'inject'))
    await host.relay('r3', 'x')
    await waitUntil(() => fake.sessions[1]!.turns.length === 1)
    expect(fake.sessions[1]!.turns[0]!.inputs).toEqual(['n2', 'r3'])
    expect(record.get()?.sessionId).toBe(fake.sessions[0]!.sessionId)
  })

  it('records the prompt version the session opened with', async () => {
    const { host, record } = make()
    await host.ensure()
    expect(record.get()).toEqual({ sessionId: 'fake-1', promptVersion: 'v1' })
  })

  it('team-only prompt change resumes with a notice', async () => {
    const { fake, host, record } = make(undefined, {
      record: { sessionId: 'S1', promptVersion: 'v0' },
      promptChange: (): PromptChange => ({ kind: 'team', notice: 'N' }),
    })
    await host.ensure()
    expect(fake.opened[0]!.resume).toBe('S1')
    expect(fake.sessions[0]!.sent[0]).toEqual({ id: 'notice:prompts:v1', text: 'N', mode: 'inject' })
    expect(record.get()?.promptVersion).toBe('v1')
  })

  it('fixed prompt change opens a new session with a context note', async () => {
    const { fake, host } = make(undefined, {
      record: { sessionId: 'S1', promptVersion: 'v0' },
      promptChange: (): PromptChange => ({ kind: 'fixed' }),
    })
    await host.ensure()
    expect(fake.opened[0]!.resume).toBeUndefined()
    expect(fake.sessions[0]!.sent[0]).toEqual({ id: 'context:prompts:v1', text: ROUTER_CONTEXT_NOTE, mode: 'inject' })
  })

  it('a failed open rejects and the next call opens', async () => {
    let fail = 1
    const { fake, host } = make(undefined, {
      runtime: inner => ({
        id: 'fake',
        probe: () => inner.probe(),
        open: async spec => {
          if (fail-- > 0) throw new Error('down')
          return inner.open(spec)
        },
      }),
    })
    await expect(host.relay('r1', 'x')).rejects.toThrow(/down/)
    await host.relay('r1', 'x')
    expect(fake.sessions[0]!.sent.map(input => input.id)).toEqual(['r1'])
  })
})
