/** Recorded SDK message sequences transcribed from M2 evidence (sdk-semantics.md: result, background-bash attempt 1, inputs-read, interrupt; SDK 0.3.321 / CLI 2.1.321), with uuids replaced by fixed fixture uuids. Tests must not read .docs/. */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { EventMapper } from '../../src/runtimes/claude/events.ts'
import type { RuntimeEvent } from '../../src/executor/contract.ts'

export type Step =
  | { kind: 'sent'; uuid: string; ids: string[] }
  | { kind: 'hook' }
  | { kind: 'skip' }
  | { kind: 'message'; message: SDKMessage }

const msg = (fields: Record<string, unknown>): Step => ({ kind: 'message', message: fields as unknown as SDKMessage })
const sent = (uuid: string, ids: string[]): Step => ({ kind: 'sent', uuid, ids })
const hook: Step = { kind: 'hook' }
const skip: Step = { kind: 'skip' }
const result = (
  uuid: string,
  subtype: string,
  cost: number,
  turns: number,
  extra: Record<string, unknown> = {},
): Step =>
  msg({
    type: 'result',
    subtype,
    session_id: 'S',
    user_message_uuid: uuid,
    total_cost_usd: cost,
    num_turns: turns,
    ...extra,
  })
const init = (sessionId: string): Step => msg({ type: 'system', subtype: 'init', session_id: sessionId })
const started = (taskId: string): Step => msg({ type: 'system', subtype: 'task_started', task_id: taskId })
const updated = (taskId: string): Step => msg({ type: 'system', subtype: 'task_updated', task_id: taskId })
const notified = (taskId: string): Step => msg({ type: 'system', subtype: 'task_notification', task_id: taskId })
const tasksChanged = (taskIds: string[]): Step =>
  msg({ type: 'system', subtype: 'background_tasks_changed', tasks: taskIds.map(task_id => ({ task_id })) })
const toolUse: Step = msg({ type: 'assistant', session_id: 'S', message: { content: [{ type: 'tool_use' }] } })
const apiError = (error: string): Step => msg({ type: 'assistant', session_id: 'S', error })

export const RECORDED: Record<string, Step[]> = {
  'streaming-costs': [
    sent('U1', ['A']),
    hook,
    result('U1', 'success', 0.00101398, 1),
    sent('U2', ['B']),
    hook,
    result('U2', 'success', 0.0012012000000000001, 1),
    sent('U3', ['C']),
    result('U3', 'success', 0.0013665300000000001, 1),
  ],
  'resumed-session': [sent('U4', ['D']), hook, result('U4', 'success', 0.00153088, 1)],
  'max-turns': [sent('U5', ['E']), hook, toolUse, result('U5', 'error_max_turns', 0.00099128, 2)],
  'max-budget': [sent('U6', ['F']), hook, result('U6', 'error_max_budget_usd', 0.0001279, 1)],
  'inject-carried': [sent('U7', ['N', 'C']), hook],
  'steer-fifo': [sent('U8', ['A']), hook, sent('U9', ['B']), sent('U10', ['S']), hook, hook],
  'background-late': [
    sent('U11', ['A']),
    toolUse,
    tasksChanged(['bn4lxutcv']),
    started('bn4lxutcv'),
    result('U11', 'success', 0.0012351099999999998, 2),
    updated('bn4lxutcv'),
    notified('bn4lxutcv'),
    tasksChanged([]),
    init('S'),
    result(undefined as unknown as string, 'success', 0.0015011699999999998, 1),
  ],
  'background-early': [
    sent('U11', ['A']),
    toolUse,
    tasksChanged(['bn4lxutcv']),
    started('bn4lxutcv'),
    updated('bn4lxutcv'),
    notified('bn4lxutcv'),
    tasksChanged([]),
    result('U11', 'success', 0.0012351099999999998, 2),
    init('S'),
    result(undefined as unknown as string, 'success', 0.0015011699999999998, 1),
  ],
  'foreground-task': [
    sent('U12', ['A']),
    hook,
    started('t-fg'),
    notified('t-fg'),
    result('U12', 'success', 0.0020489700000000002, 2),
  ],
  'api-error': [
    sent('U13', ['A']),
    hook,
    apiError('overloaded'),
    result('U13', 'success', 0.0005, 1, { is_error: true }),
    sent('U14', ['B']),
    hook,
    result('U14', 'success', 0.0009, 1),
  ],
  'auth-error': [
    sent('U15', ['A']),
    apiError('authentication_failed'),
    result('U15', 'success', 0, 1, { is_error: true }),
  ],
  interrupted: [
    sent('U16', ['A']),
    hook,
    skip,
    result('U16', 'error_during_execution', 0.00100205, 3),
    sent('U17', ['B']),
    hook,
    result('U17', 'success', 0.0015, 1),
  ],
}

export function replay(steps: Step[], sessionId = 'S'): RuntimeEvent[] {
  const mapper = new EventMapper(sessionId)
  const events: RuntimeEvent[] = []
  for (const step of steps) {
    if (step.kind === 'sent') mapper.sent(step.uuid, step.ids)
    else if (step.kind === 'hook') events.push(...mapper.read())
    else if (step.kind === 'skip') mapper.skipNextResult()
    else events.push(...mapper.message(step.message))
  }
  return events
}
