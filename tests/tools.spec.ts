/** Worker tool specs: tool names, report reaching the engine, human_action and acknowledgement limits, thread keys. */
import { describe, expect, it, vi } from 'vitest'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
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
    ticket: () => (ended ? { ended } as never : {} as never),
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
    expect(executorTools(h, { id: 'T1' }).map(item => item.name)).toEqual([
      'orchestrator_ack', 'orchestrator_thread_unrelated', 'orchestrator_thread_follow', 'orchestrator_trigger_handback', 'orchestrator_report',
    ])
  })

  it('a valid report reaches the engine', async () => {
    const { engine, host: h } = host()
    const report = find(executorTools(h, { id: 'T1' }), 'orchestrator_report')
    const result = await report.execute({ state: 'progress', summary: 's', human_action: 'Can you grant push access to owner/repo?' }, new AbortController().signal)
    expect(engine.report).toHaveBeenCalledWith('T1', { state: 'progress', summary: 's', question: 'Can you grant push access to owner/repo?' })
    expect(result).toEqual({ reported: true })
  })

  it.each([
    'Approve it. Then merge it?',
    'Approve? Merge?',
    'word '.repeat(101) + 'ok?',
    'Approve?\nMerge?',
    ['a?', 'b?'],
  ])('human_action %s is a tool error', async (humanAction) => {
    const { engine, host: h } = host()
    const report = find(executorTools(h, { id: 'T1' }), 'orchestrator_report')
    await expect(report.execute({ state: 'progress', summary: 's', human_action: humanAction }, new AbortController().signal)).rejects.toThrow()
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
    await expect(report.execute({ state: 'ready', summary: 's' }, new AbortController().signal)).rejects.toThrow(/Ticket ended/)
  })

  it('ack text over 100 words is rejected; a short ack is sent', async () => {
    const { engine, host: h } = host()
    const ack = find(executorTools(h, { id: 'T1' }), 'orchestrator_ack')
    await expect(ack.execute({ trigger_id: 'A', text: 'word '.repeat(101) }, new AbortController().signal)).rejects.toThrow()
    expect(engine.reply).not.toHaveBeenCalled()
    const result = await ack.execute({ trigger_id: 'A', text: 'On it.' }, new AbortController().signal)
    expect(engine.reply).toHaveBeenCalledWith({ purpose: 'acknowledgement', ticketId: 'T1', triggerId: 'A', text: 'On it.' })
    expect(result).toEqual({ trigger_id: 'A', acknowledgement: 'pending', reused: false })
  })

  it('thread_follow rejects a key without a source', async () => {
    const { host: h } = host()
    const follow = find(executorTools(h, { id: 'T1' }), 'orchestrator_thread_follow')
    await expect(follow.execute({ thread: 'github', reason: 'r' }, new AbortController().signal)).rejects.toThrow()
  })
})
