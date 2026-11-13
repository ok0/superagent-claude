/** Worker tool specs: tool names, report reaching the engine, human_action and acknowledgement limits, thread keys. */
import { describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import { WORKER_TOOLS } from '../src/app/tool-names.ts'
import type { ToolSpec } from '../src/executor/contract.ts'

function host(ended?: { by: string }) {
  const engine = {
    report: vi.fn((_ticketId: string, _report: unknown) => ({ attention: undefined })),
    reply: vi.fn(() => ({ id: 'r1', status: 'pending', reused: false })),
    handback: vi.fn(() => true),
    followForContext: vi.fn(() => true),
    markUnrelated: vi.fn(),
  }
  const h: ExecutorToolsHost = {
    engine: () => engine as never,
    ticket: () => (ended ? ({ ended } as never) : ({} as never)),
  }
  return { engine, host: h }
}

function find(tools: ToolSpec[], name: string): ToolSpec {
  const found = tools.find(item => item.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

describe('worker tools', () => {
  it('executor tools have the worker tool names', () => {
    const { host: h } = host()
    const names = executorTools(h, { id: 'T1' }).map(item => item.name)
    expect(names).toEqual([...WORKER_TOOLS])
    expect(names).toHaveLength(11)
  })

  it('orchestrator_read without a reader is a tool error', async () => {
    const { host: h } = host()
    const read = find(executorTools(h, { id: 'T1' }), 'orchestrator_read')
    await expect(read.execute({ resource: 'ticket/T1' }, new AbortController().signal)).rejects.toThrow(/No resources/)
  })

  it('orchestrator_read passes resource, offset and limit', async () => {
    const read = vi.fn(async () => 'page')
    const { host: base } = host()
    const h: ExecutorToolsHost = { ...base, read }
    const tool = find(executorTools(h, { id: 'T1' }), 'orchestrator_read')
    const signal = new AbortController().signal
    await expect(tool.execute({ resource: 'ticket/T1' }, signal)).resolves.toBe('page')
    expect(read).toHaveBeenCalledWith('ticket/T1', 0, undefined, signal)
  })

  it('thread_follow refuses a repository outside the list, without case', async () => {
    const { engine, host: base } = host()
    const h: ExecutorToolsHost = { ...base, repositories: () => ['owner/repo'] }
    const follow = find(executorTools(h, { id: 'T1' }), 'orchestrator_thread_follow')
    await follow.execute({ thread: 'github:Owner/Repo#7', reason: 'The issue it fixes.' }, new AbortController().signal)
    expect(engine.followForContext).toHaveBeenCalledWith('T1', { source: 'github', id: 'Owner/Repo#7' })
    await expect(
      follow.execute({ thread: 'github:other/repo#7', reason: 'r' }, new AbortController().signal),
    ).rejects.toThrow(/not in the configured repositories/)
    expect(engine.followForContext).toHaveBeenCalledTimes(1)
  })

  it('thread_follow notifies the Router', async () => {
    const { host: base } = host()
    const notify = vi.fn()
    const h: ExecutorToolsHost = { ...base, notify }
    const follow = find(executorTools(h, { id: 'T1' }), 'orchestrator_thread_follow')
    await follow.execute({ thread: 'chat:t9', reason: 'Same topic.' }, new AbortController().signal)
    expect(notify).toHaveBeenCalledTimes(1)
    const [notice] = notify.mock.calls[0] as unknown as [readonly [string, Record<string, unknown>, string]]
    expect(notice[1]).toHaveProperty('thread_followed')
  })

  it('a valid report reaches the engine', async () => {
    const { engine, host: h } = host()
    const report = find(executorTools(h, { id: 'T1' }), 'orchestrator_report')
    const result = await report.execute(
      { state: 'progress', summary: 's', human_action: 'Can you grant push access to owner/repo?' },
      new AbortController().signal,
    )
    expect(engine.report).toHaveBeenCalledWith('T1', {
      state: 'progress',
      summary: 's',
      question: 'Can you grant push access to owner/repo?',
    })
    expect(result).toEqual({ reported: true })
  })

  it('the report tool has no host-only fields and refuses them', async () => {
    const { engine, host: h } = host()
    const report = find(executorTools(h, { id: 'T1' }), 'orchestrator_report')
    expect(Object.keys(report.schema.shape)).not.toContain('workspace')
    expect(Object.keys(report.schema.shape)).not.toContain('limit')
    await expect(
      report.execute({ state: 'blocked', summary: 's', workspace: true }, new AbortController().signal),
    ).rejects.toThrow(ZodError)
    expect(engine.report).not.toHaveBeenCalled()
  })

  it.each([
    'Approve it. Then merge it?',
    'Approve? Merge?',
    'word '.repeat(101) + 'ok?',
    'Approve?\nMerge?',
    ['a?', 'b?'],
  ])('human_action %s is a tool error', async humanAction => {
    const { engine, host: h } = host()
    const report = find(executorTools(h, { id: 'T1' }), 'orchestrator_report')
    await expect(
      report.execute({ state: 'progress', summary: 's', human_action: humanAction }, new AbortController().signal),
    ).rejects.toThrow()
    expect(engine.report).not.toHaveBeenCalled()
  })

  it('human_action null clears and omission keeps', async () => {
    const { engine, host: h } = host()
    const report = find(executorTools(h, { id: 'T1' }), 'orchestrator_report')
    await report.execute({ state: 'progress', summary: 's', human_action: null }, new AbortController().signal)
    expect(engine.report.mock.calls[0]?.[1]).toMatchObject({ question: null })
    await report.execute({ state: 'progress', summary: 's' }, new AbortController().signal)
    expect(engine.report.mock.calls[1]?.[1]).not.toHaveProperty('question')
  })

  it('a report on an ended ticket fails', async () => {
    const { h } = { h: host({ by: 'human' }).host }
    const report = find(executorTools(h, { id: 'T1' }), 'orchestrator_report')
    await expect(report.execute({ state: 'ready', summary: 's' }, new AbortController().signal)).rejects.toThrow(
      /Ticket ended/,
    )
  })

  it('ack text over 100 words is rejected; a short ack is sent', async () => {
    const { engine, host: h } = host()
    const ack = find(executorTools(h, { id: 'T1' }), 'orchestrator_ack')
    await expect(
      ack.execute({ trigger_id: 'A', text: 'word '.repeat(101) }, new AbortController().signal),
    ).rejects.toThrow()
    expect(engine.reply).not.toHaveBeenCalled()
    const result = await ack.execute({ trigger_id: 'A', text: 'On it.' }, new AbortController().signal)
    expect(engine.reply).toHaveBeenCalledWith({
      purpose: 'acknowledgement',
      ticketId: 'T1',
      triggerId: 'A',
      text: 'On it.',
    })
    expect(result).toEqual({ trigger_id: 'A', acknowledgement: 'pending', reused: false })
  })

  it('thread_follow rejects a key without a source', async () => {
    const { host: h } = host()
    const follow = find(executorTools(h, { id: 'T1' }), 'orchestrator_thread_follow')
    await expect(follow.execute({ thread: 'github', reason: 'r' }, new AbortController().signal)).rejects.toThrow()
  })

  it('a report title reaches the engine and omission keeps the title', async () => {
    const { engine, host: h } = host()
    const report = find(executorTools(h, { id: 'T1' }), 'orchestrator_report')
    await report.execute(
      { state: 'progress', summary: 's', title: '  Add WELCOME.md instead  ' },
      new AbortController().signal,
    )
    expect(engine.report.mock.calls[0]?.[1]).toMatchObject({ title: 'Add WELCOME.md instead' })
    await report.execute({ state: 'progress', summary: 's' }, new AbortController().signal)
    expect(engine.report.mock.calls[1]?.[1]).not.toHaveProperty('title')
    await expect(
      report.execute({ state: 'progress', summary: 's', title: 'x'.repeat(200) }, new AbortController().signal),
    ).resolves.toEqual({ reported: true })
  })

  it.each(['', '   ', 'x'.repeat(201)])('report title %# is a tool error', async title => {
    const { engine, host: h } = host()
    const report = find(executorTools(h, { id: 'T1' }), 'orchestrator_report')
    await expect(
      report.execute({ state: 'progress', summary: 's', title }, new AbortController().signal),
    ).rejects.toThrow()
    expect(engine.report).not.toHaveBeenCalled()
  })
})

describe('git_inspect tool', () => {
  it('wraps the host output as external data', async () => {
    const inspect = vi.fn(async () => 'commit abc\n')
    const { host: h } = host()
    const tools = executorTools({ ...h, inspect }, { id: 'T1' })
    const out = await find(tools, 'git_inspect').execute({ command: 'log', limit: 3 }, new AbortController().signal)
    expect(String(out).startsWith('<external-data source="git-inspect">')).toBe(true)
    expect(String(out)).toContain('commit abc')
    expect(inspect).toHaveBeenCalledWith('T1', { command: 'log', limit: 3 })
  })

  it('rejects unknown fields and commands before the host', async () => {
    const inspect = vi.fn(async () => '')
    const { host: h } = host()
    const tools = executorTools({ ...h, inspect }, { id: 'T1' })
    const signal = new AbortController().signal
    await expect(find(tools, 'git_inspect').execute({ command: 'log', flags: '-p' }, signal)).rejects.toThrow(ZodError)
    await expect(find(tools, 'git_inspect').execute({ command: 'status' }, signal)).rejects.toThrow(ZodError)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('is a tool error without a worktree', async () => {
    const { host: h } = host()
    const tools = executorTools(h, { id: 'T1' })
    await expect(find(tools, 'git_inspect').execute({ command: 'log' }, new AbortController().signal)).rejects.toThrow(
      /no git worktree/,
    )
  })
})
