/** Maps Claude SDK stream messages to runtime events: input reads, session ids, turn ends and background task counts. */
import type { SDKAssistantMessageError, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeEvent, TurnOutcome } from '../../executor/contract.ts'

export function outcomeOf(subtype: string): TurnOutcome {
  if (subtype === 'success') return 'success'
  if (subtype === 'error_max_turns') return 'max_turns'
  if (subtype === 'error_max_budget_usd') return 'budget'
  return 'error'
}

export const RETRYABLE_API_ERRORS: ReadonlySet<string> = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
  'unknown',
])

interface Group {
  uuid: string
  ids: string[]
}

export function subagentMessage(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false
  const m = msg as Record<string, unknown>
  return typeof m.agent_id === 'string' || (typeof m.parent_tool_use_id === 'string' && m.parent_tool_use_id !== '')
}

export class EventMapper {
  private sessionId: string
  private readonly fifo: Group[] = []
  private readonly awaiting = new Set<string>()
  private readonly finished = new Set<string>()
  private skips = 0
  private lastTotal = 0
  private lastError: SDKAssistantMessageError | undefined

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  sent(uuid: string, ids: readonly string[]): void {
    this.fifo.push({ uuid, ids: [...ids] })
  }

  read(): RuntimeEvent[] {
    if (this.fifo.length === 0) return []
    const ids = this.fifo.flatMap(group => group.ids)
    this.fifo.length = 0
    return [{ type: 'inputsRead', ids }]
  }

  queued(uuids: readonly string[]): string[] {
    return this.fifo.filter(group => uuids.includes(group.uuid)).flatMap(group => group.ids)
  }

  skipNextResult(): void {
    this.skips += 1
  }

  message(msg: SDKMessage): RuntimeEvent[] {
    const m = msg as Record<string, unknown>
    if (subagentMessage(msg) && (m.type === 'assistant' || m.type === 'result')) return []
    switch (m.type) {
      case 'system':
        return this.system(m)
      case 'assistant':
        if (typeof m.error === 'string') this.lastError = m.error as SDKAssistantMessageError
        return []
      case 'result':
        return this.result(m)
      default:
        return []
    }
  }

  private system(m: Record<string, unknown>): RuntimeEvent[] {
    if (m.subtype === 'init') {
      if (typeof m.session_id === 'string' && m.session_id !== this.sessionId) {
        this.sessionId = m.session_id
        return [{ type: 'session', sessionId: this.sessionId }]
      }
      return []
    }
    if (m.subtype === 'background_tasks_changed') {
      const tasks = Array.isArray(m.tasks) ? (m.tasks as Record<string, unknown>[]) : []
      const live = tasks.filter(task => task.ambient !== true).map(task => String(task.task_id))
      for (const id of live) this.awaiting.add(id)
      for (const id of this.awaiting) if (!live.includes(id)) this.finished.add(id)
      return []
    }
    if (m.subtype === 'task_notification') {
      const id = String(m.task_id)
      if (this.awaiting.has(id)) this.finished.add(id)
      return []
    }
    return []
  }

  private result(m: Record<string, unknown>): RuntimeEvent[] {
    const total = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0
    if (this.skips > 0) {
      this.skips -= 1
      const discarded = total >= this.lastTotal ? total - this.lastTotal : total
      this.lastTotal = total
      this.lastError = undefined
      return [
        {
          type: 'turnEnded',
          outcome: 'success',
          turns: typeof m.num_turns === 'number' ? m.num_turns : 1,
          costUsd: discarded,
          background: 0,
          discarded: true,
        },
      ]
    }
    const out: RuntimeEvent[] = []
    if (typeof m.user_message_uuid === 'string') {
      const at = this.fifo.findIndex(group => group.uuid === m.user_message_uuid)
      if (at >= 0) {
        for (const group of this.fifo.splice(0, at + 1)) out.push({ type: 'inputsRead', ids: group.ids })
      }
    } else {
      for (const id of this.finished) this.awaiting.delete(id)
      this.finished.clear()
    }
    const subtype = String(m.subtype)
    if (this.lastError !== undefined && (m.is_error === true || subtype !== 'success')) {
      out.push({
        type: 'error',
        message: `The model API failed: ${this.lastError}`,
        retryable: RETRYABLE_API_ERRORS.has(this.lastError),
      })
      this.lastError = undefined
      return out
    }
    const costUsd = total >= this.lastTotal ? total - this.lastTotal : total
    this.lastTotal = total
    this.lastError = undefined
    out.push({
      type: 'turnEnded',
      outcome: outcomeOf(subtype),
      turns: typeof m.num_turns === 'number' ? m.num_turns : 1,
      costUsd,
      background: this.awaiting.size,
    })
    return out
  }
}
