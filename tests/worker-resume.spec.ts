/**
 * Session resume: a ticket that ended or went idle resumes on a person's message with its stored session and worktree, and the prompt-version change decides between resume, a team notice and a new session with a context note (ADR-18).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { PromptChange } from '../src/executor/worker-executor.ts'
import type { FakeScript } from '../src/runtimes/fake/runtime.ts'
import { waitUntil } from './fixtures/async.ts'
import { accepted, guest, trigger } from './fixtures/engine.ts'
import { workerHarness } from './fixtures/executor.ts'

type Harness = ReturnType<typeof workerHarness>
const READY: FakeScript = ({ index }) => index === 0 ? { tools: [{ name: 'report', args: { state: 'ready', summary: 'done' } }] } : {}
async function endedTicket(w: Harness): Promise<string> {
  const id = accepted(w, '1').ticketId!
  await waitUntil(() => !!w.ticket(id).ended && !!w.runtime.sessions.at(-1)?.closed)
  return id
}
const wake = (w: Harness, n: string): void => { w.engine.receive(trigger(n, { actor: guest })); w.pump() }

it('resumes an ended ticket on a person\'s message with its stored session and worktree, also after the executor is recreated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-resume-'))
  try {
    const w1 = workerHarness({ directory, script: READY })
    const id = await endedTicket(w1)
    const stored = w1.workers.get(id)!
    wake(w1, '2')
    await waitUntil(() => w1.runtime.opened.length === 2)
    expect(w1.runtime.opened[1]!.resume).toBe(stored.sessionId)
    expect(w1.runtime.opened[1]!.cwd).toBe(stored.cwd)
    await waitUntil(() => !!w1.ticket(id).ended && !!w1.runtime.sessions.at(-1)?.closed)
    await w1.executor.dispose()
    await w1.effects.drain()
    w1.store.close()

    const w2 = workerHarness({ directory, script: READY })
    try {
      expect(w2.workers.get(id)!.sessionId).toBe(stored.sessionId)
      wake(w2, '3')
      await waitUntil(() => w2.runtime.opened.length === 1)
      expect(w2.runtime.opened[0]!.resume).toBe(stored.sessionId)
      expect(w2.runtime.opened[0]!.cwd).toBe(stored.cwd)
    } finally { await w2.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('team-only change: resumes and merges the latest team notice into the first input', async () => {
  let version = 'v1'
  const promptChange = vi.fn((stored: string): PromptChange => stored === version ? { kind: 'same' } : { kind: 'team', notice: 'NOTICE team' })
  const w = workerHarness({ script: READY, deps: { promptVersion: () => version, instructions: async () => `instructions-${version}`, promptChange, history: async () => 'abc1234 first commit' } })
  try {
    const id = await endedTicket(w)
    const stored = w.workers.get(id)!
    expect(stored.promptVersion).toBe('v1')
    version = 'v2'
    wake(w, '2')
    await waitUntil(() => w.runtime.sessions.length === 2 && w.runtime.sessions[1]!.turns.length >= 1)
    expect(promptChange).toHaveBeenCalledWith('v1')
    expect(w.runtime.opened[1]!.resume).toBe(stored.sessionId)
    const a2 = w.ticket(id).assignments[1]!.id
    expect(w.runtime.sessions[1]!.sent[0]).toEqual({ id: 'notice:prompts:v2', mode: 'inject', text: 'NOTICE team' })
    expect(w.runtime.sessions[1]!.turns[0]!.inputs.slice(0, 2)).toEqual(['notice:prompts:v2', `assignment:${a2}`])
    expect(w.workers.get(id)!.promptVersion).toBe('v2')
  } finally { await w.close() }
})

it('host or built-in change: opens a new session with the latest instructions and a context note first', async () => {
  let version = 'v1'
  const promptChange = vi.fn((stored: string): PromptChange => stored === version ? { kind: 'same' } : { kind: 'fixed' })
  const w = workerHarness({ script: READY, deps: { promptVersion: () => version, instructions: async () => `instructions-${version}`, promptChange, history: async () => 'abc1234 first commit' } })
  try {
    const id = await endedTicket(w)
    const stored = w.workers.get(id)!
    version = 'v2'
    wake(w, '2')
    await waitUntil(() => w.runtime.sessions.length === 2 && w.runtime.sessions[1]!.turns.length >= 1)
    const opened = w.runtime.opened[1]!
    expect(opened.resume).toBeUndefined()
    expect(opened.instructions).toBe('instructions-v2')
    const s2 = w.runtime.sessions[1]!
    const a2 = w.ticket(id).assignments[1]!.id
    expect(s2.sent[0]).toMatchObject({ id: 'context:prompts:v2', mode: 'followup' })
    expect(s2.sent[0]!.text).toContain('abc1234 first commit')
    expect(s2.sent[0]!.text).toContain(stored.cwd)
    expect(s2.sent[0]!.text).toContain(id)
    expect(s2.sent[1]!.id).toBe(`assignment:${a2}`)
    expect(s2.sent[1]!.text).toContain('"title"')
    expect(w.workers.get(id)!.sessionId).toBe(s2.sessionId)
    expect(w.workers.get(id)!.sessionId).not.toBe(stored.sessionId)
    expect(w.workers.get(id)!.promptVersion).toBe('v2')
  } finally { await w.close() }
})

it('unchanged prompt: resumes without a notice', async () => {
  let version = 'v1'
  const promptChange = vi.fn((): PromptChange => ({ kind: 'same' }))
  const w = workerHarness({ script: READY, deps: { promptVersion: () => version, instructions: async () => `instructions-${version}`, promptChange } })
  try {
    const id = await endedTicket(w)
    const stored = w.workers.get(id)!
    wake(w, '2')
    await waitUntil(() => w.runtime.sessions.length === 2 && w.runtime.sessions[1]!.turns.length >= 1)
    const a2 = w.ticket(id).assignments[1]!.id
    expect(w.runtime.opened[1]!.resume).toBe(stored.sessionId)
    const sent = w.runtime.sessions[1]!.sent
    expect(sent.some(input => input.id.startsWith('notice:') || input.id.startsWith('context:'))).toBe(false)
    expect(sent[0]!.id).toBe(`assignment:${a2}`)
    expect(w.workers.get(id)!.promptVersion).toBe('v1')
  } finally { await w.close() }
})

it('applies the prompt branch when an idle live ticket wakes for new input', async () => {
  let version = 'v1'
  const promptChange = vi.fn((stored: string): PromptChange => stored === version ? { kind: 'same' } : { kind: 'team', notice: 'NOTICE team' })
  const w = workerHarness({ deps: { promptVersion: () => version, instructions: async () => `instructions-${version}`, promptChange, history: async () => 'abc1234 first commit' } })
  try {
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.runtime.sessions.length === 1 && w.runtime.sessions[0]!.closed)
    const stored = w.workers.get(id)!
    expect(stored.promptVersion).toBe('v1')
    version = 'v2'
    wake(w, '2')
    await waitUntil(() => w.runtime.opened.length === 2)
    expect(w.runtime.opened[1]!.resume).toBe(stored.sessionId)
    expect(w.runtime.sessions[1]!.sent[0]).toMatchObject({ id: 'notice:prompts:v2', mode: 'inject' })
    await waitUntil(() => w.workers.get(id)?.promptVersion === 'v2')
  } finally { await w.close() }
})
