// Ported from dsh-superagent-prototype (MIT) src/core/replies.ts
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, TicketInput, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * `result` needs a ticket that is `ready`, `completed`, `merged`, or `dropped`. Without `ticketId`, the ticket
 * `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | {
      purpose: 'answer' | 'result' | 'attention'
      ticketId?: string
      triggerId?: string
      question?: string
      text: string
    }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply {
  id: string
  status: ReplyStatus
  reused: boolean
}

export const REFUSAL_PREFIX = "I can't take this on here: "
const REFUSAL_FALLBACK = 'it is outside what I can do.'
const INTERNAL =
  /\b(?:tickets?|workers?|hand(?:ed|s|ing)?[\s-]?backs?|evals?|triggers?|orchestrator|assignments?)\b|\b[0-9a-f]{16,}\b/i
const SENTENCE = /(?<=[.!?。！？])\s+|\n/
const CLAUSE = /\s*(?:[,;，；()（）]|:(?=\s)|(?<=\s)[-–—](?=\s))\s*/
const TRIGGER_NOUN = /\b(the|this|that|these|those)\s+trigger(s?)\b/gi
function readable(sentence: string): string | undefined {
  const text = sentence.replace(TRIGGER_NOUN, (_m, d: string, s: string) => d + ' message' + s)
  if (!INTERNAL.test(text)) return text
  const kept = text
    .split(CLAUSE)
    .map(c => c.trim())
    .filter(c => c !== '' && !INTERNAL.test(c) && c.split(/\s+/).length >= 3)
  if (kept.length === 0) return undefined
  const joined = kept.join(', ').replace(/[\s.!?。！？]+$/u, '')
  return joined.charAt(0).toUpperCase() + joined.slice(1) + '.'
}
/**
 * The refusal a person gets for an explicit request the assessor ignored: the first sentence of its reason that a
 * person can read: internal terms rewritten (`the trigger` → `the message`) or their clauses dropped; a fixed phrase
 * when nothing is left; at most 200 characters.
 */
export function refusalText(reason: string): string {
  let body = REFUSAL_FALLBACK
  for (const sentence of reason.trim().split(SENTENCE)) {
    const found = sentence.trim() && readable(sentence.trim())
    if (found) {
      body = found
      break
    }
  }
  const text = REFUSAL_PREFIX + body
  return text.length <= 200 ? text : text.slice(0, 199).trimEnd() + '…'
}

export function limitText(limit: 'turn' | 'budget', pull?: string): string {
  return (
    `I stopped before finishing: the ${limit} limit for this task was reached.` +
    (pull ? ` Work so far: ${pull}.` : '') +
    ' Reply here to continue.'
  )
}

/** The note a person gets when a configured branch is missing, so the task could not start. */
export function workspaceBlockedText(reason: string): string {
  return `I could not start this task. ${reason} Reply here once that is fixed to try again.`
}

/**
 * Each message is queued under a deterministic id, so it is never sent twice. Replies to a person go where the person's
 * message was written, and a result where the latest person's message to the ticket was written.
 */
export class Replies extends EnginePart {
  /**
   * An acknowledgement or an answer goes where that person's message was written; attention where the message that
   * raised the question was, else to the ticket's starting conversation. Each message is queued at most once
   * (idempotent). An acknowledgement, even one already queued, records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a
   * ticket that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human)
      this.options.outbox.send({
        id: key('ack', trigger.id),
        channel: trigger.channel,
        text,
        kind: 'acknowledgement',
        ticketId,
      })
  }
  /**
   * Queue, once per Assignment, the note that a turn or budget limit stopped the work, where the latest person's
   * message to the ticket was written, else where it started; id `limit:<assignmentId>`.
   */
  limitStopped(ticket: Ticket, assignmentId: string, limit: 'turn' | 'budget', pull?: string): void {
    const channel = this.replyChannel(ticket)
    if (channel)
      this.options.outbox.send({
        id: `limit:${assignmentId}`,
        channel,
        text: limitText(limit, pull),
        kind: 'reply',
        ticketId: ticket.id,
      })
  }
  /**
   * Queue the reason the task could not start where the latest person's message to the ticket was written, else where
   * it started; nothing when there is no conversation. Its id is `workspace-blocked:<assignmentId>:<triggerId>` for
   * the latest person's message, so a repeat or restart sends nothing more, and a person's reply that meets the same
   * block is told again.
   */
  workspaceBlocked(ticket: Ticket, assignmentId: string, reason: string): void {
    const channel = this.replyChannel(ticket)
    if (!channel) return
    const latest =
      ticket.inputs.findLast(
        (input): input is Extract<TicketInput, { kind: 'trigger' }> =>
          input.kind === 'trigger' && input.human === true && !input.context,
      )?.triggerId ?? (this.repo.triggers.get(ticket.origin.triggerId)?.human ? ticket.origin.triggerId : undefined)
    this.options.outbox.send({
      id: latest ? `workspace-blocked:${assignmentId}:${latest}` : `workspace-blocked:${assignmentId}`,
      channel,
      text: workspaceBlockedText(reason),
      kind: 'reply',
      ticketId: ticket.id,
    })
  }
  withdrawAttention(attentionId: string): void {
    this.options.outbox.withdraw(key('attention-reply', attentionId))
  }
  /**
   * Queue the refusal of a person's explicit request once, where it was written: its id is `refusal:<triggerId>`, so a
   * replay or restart does not send it again.
   */
  refuse(trigger: Trigger, reason: string): void {
    if (!trigger.channel) return
    this.options.outbox.send({
      id: `refusal:${trigger.id}`,
      channel: trigger.channel,
      text: refusalText(reason),
      kind: 'reply',
    })
  }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing)
      this.options.outbox.send({
        id,
        channel: trigger.channel,
        text: request.text,
        kind: 'acknowledgement',
        ticketId: ticket.id,
      })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId
      ? this.require(request.ticketId)
      : trigger
        ? this.repo.tickets.list().find(item => this.reaches(item, trigger))
        : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question))
      throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = attention
      ? key('attention-reply', attention.id)
      : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel =
      request.purpose === 'answer'
        ? trigger!.channel
        : request.purpose === 'attention'
          ? (asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined))
          : ticket
            ? this.replyChannel(ticket)
            : undefined
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({
      id,
      channel,
      text: request.text,
      kind: 'reply',
      ...(ticket ? { ticketId: ticket.id } : {}),
    })
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined {
    return this.source(ticket)?.channel ?? ticket.channels[0]
  }
  /**
   * Where a ticket's result goes: the Channel of the latest person's message that reached it on a Thread it works on
   * (not one it follows for context), else the conversation it started in.
   */
  private replyChannel(ticket: Ticket): ChannelRef | undefined {
    const latest = ticket.inputs.findLast(
      (input): input is Extract<TicketInput, { kind: 'trigger' }> =>
        input.kind === 'trigger' &&
        input.human === true &&
        !input.context &&
        this.repo.triggers.get(input.triggerId)?.channel !== undefined,
    )
    return (latest && this.repo.triggers.get(latest.triggerId)?.channel) ?? this.sourceChannel(ticket)
  }
}
