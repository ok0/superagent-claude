// Ported from dsh-superagent-prototype (MIT) src/core/assignments.ts
/** What the Executor and its workers report about the Assignments that run tickets. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { caughtUp, latestAssignment, latestReport, liveTicket, runningAssignment } from './model.ts'
import type { ReportState, Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { automatic, type Tickets } from './tickets.ts'

/** What an Assignment reports: a worker's report, or the Executor's own (`waiting` after an idle turn, `failed` after an error). */
export interface WorkerReport {
  state: ReportState
  summary: string
  /** Open question for a person: a string asks it, `null` clears an open one, and `undefined` keeps the current one. */
  question?: string | null
  /** The person's message whose request raised the question; routes the question to the channel where it was written. */
  askedBy?: string
  /** The person's question this report answers, which the worker thereby takes up; authorizes the main Session to send an answer reply. */
  answers?: string
  /** A new ticket title after a person's message changed the request (ADR-25); undefined keeps the current one. */
  title?: string
  /** Host-only: a turn or budget limit stopped the worker. A `blocked` report with it tells the person once (ADR-32). */
  limit?: 'turn' | 'budget'
}
// Port note: vendor-specific state wording neutralised to "remote state" (charter R11); behavior unchanged.
const RECOVERY_NOTE = 'The host restarted during this ticket. Inspect the current worktree, git history and remote state before continuing. Do not repeat an already completed external operation. Finish the original assignment and report its status.'

/**
 * Assignments records what the Executor and its workers report about the Assignments that run tickets: one started, Inputs
 * reached it or failed to, its worker's Session took Inputs into a step, a turn of its worker ended, a host restart
 * interrupted it, and a worker's report with its question for a person. It depends on
 * Tickets to restart or end a ticket and on Replies to withdraw a question a report replaced; the Engine routes the
 * Executor's lifecycle callbacks and its workers' reports here.
 */
export class Assignments extends EnginePart {
  private readonly tickets: Tickets
  private readonly replies: Replies
  // Port note: parameter properties expanded to explicit fields (erasableSyntaxOnly); behavior unchanged.
  constructor(options: EngineOptions, tickets: Tickets, replies: Replies) { super(options); this.tickets = tickets; this.replies = replies }

  /** Marks a non-ended assignment running, queues a held accept acknowledgement (ADR-32), queues delivery of waiting undelivered inputs on an open ticket, and emits `assignment.started`. */
  started(ticketId: string, assignmentId: string): void {
    const ticket = this.require(ticketId)
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (!assignment || assignment.state === 'ended') return
    assignment.state = 'running'; assignment.startedAt ??= this.now()
    const held = ticket.acknowledgement; delete ticket.acknowledgement
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    if (held) { const trigger = this.repo.triggers.get(held.triggerId); if (trigger) this.replies.acknowledgeAccepted(ticketId, trigger, held.text) }
    if (liveTicket(ticket) && ticket.undelivered.length) this.options.executor.deliver(ticket, assignment)
    this.emit('assignment.started', { ticketId, assignmentId })
  }
  /**
   * Marks `inputIds` delivered on the ticket's running assignment and clears any prior `delivery` failure; ignored if no
   * longer running. Its worker reads each once its Session takes it into a step (see `read`).
   */
  delivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.undelivered = ticket.undelivered.filter(id => !inputIds.includes(id)); ticket.updatedAt = this.now()
    runningAssignment(ticket)!.deliveredAt = ticket.updatedAt
    for (const input of ticket.inputs) {
      if (input.kind === 'trigger' && inputIds.includes(input.id)) { input.readAt ??= null; input.deliveredTo = assignmentId }
    }
    delete ticket.delivery
    this.repo.tickets.save(ticket)
  }
  /** Records when the worker's Session of an open ticket took `inputIds` into a step, from which its model reads them. */
  read(ticketId: string, inputIds: string[]): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    for (const input of ticket.inputs) if (input.kind === 'trigger' && inputIds.includes(input.id)) input.readAt ||= this.now()
    this.repo.tickets.save(ticket)
  }
  turnEnded(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    runningAssignment(ticket)!.idleAt = this.now()
    this.repo.tickets.save(ticket)
  }
  /**
   * A worker's Session stopped at its turn or budget limit (`limit`). A ticket whose latest report is `ready` and whose worker
   * took up no person's message since keeps that report: the running Assignment carries it, so the ticket shows as ready for
   * review, and the caller reports nothing (ADR-24). Emits `worker.limit` either way.
   * @returns whether the ticket kept its ready report; false when `assignmentId` no longer runs the open ticket.
   */
  limited(ticketId: string, assignmentId: string, limit: string): boolean {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return false
    const kept = this.tickets.keepsReady(ticket)
    const running = runningAssignment(ticket)!
    if (kept && running.report?.state !== 'ready') {
      running.report = { ...latestReport(ticket)! }
      ticket.updatedAt = this.now()
      this.repo.tickets.save(ticket)
    }
    this.emit('worker.limit', { ticketId, assignmentId, limit, kept })
    return kept
  }
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.delivery = { error: error.slice(0, 300), at: this.now() }
    this.repo.tickets.save(ticket)
  }
  /**
   * Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest report is
   * `waiting`, `ready`, `blocked`, or `failed` and no input reached its worker after that report that a later finished turn
   * did not take in (ADR-32), in which case it keeps its session and flushes any waiting undelivered inputs.
   */
  interrupted(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    const running = ticket && runningAssignment(ticket)
    if (!ticket || !running) return
    const report = running.report
    const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at && !caughtUp(ticket, running)
    const settled = !!report && ['waiting', 'ready', 'blocked', 'failed'].includes(report.state) && !busy
    if (!settled) this.tickets.restart(ticket, running, 'hostRestarted', RECOVERY_NOTE)
    else if (ticket.undelivered.length) this.options.executor.deliver(ticket, running)
  }
  /**
   * Records a worker status report on an open ticket's current assignment, updating `attention`, `answers`, held automated
   * inputs, and ending the ticket when `dropped` or when `ready` and not waiting on followed threads (`followsDone`).
   * @throws UserError for an unknown or ended ticket, an ended assignment, a question combined with a ready result or answer,
   * or a question/answer referencing a non-human or unreached trigger.
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (report.question && (report.state === 'ready' || report.answers)) throw new UserError('questionWithResult')
    if (report.askedBy && !report.question) throw new UserError('askerWithoutQuestion')
    const person = (id: string, channel: boolean) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false)
    }
    if (report.askedBy && !person(report.askedBy, true)) throw new UserError('notAsker')
    if (report.answers && !person(report.answers, false)) throw new UserError('notAnswerable')
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!assignment) throw new UserError('unknownAssignment')
    if (assignment.state === 'ended') throw new UserError('assignmentEnded')
    const at = this.now()
    const previous = ticket.attention
    const ask = (question: string) => ({ id: key('attention', ticketId, question, at), question, ...(report.askedBy ? { triggerId: report.askedBy } : {}) })
    const asked = report.question && report.question !== previous?.question ? ask(report.question) : previous
    const attention = report.question === null || report.state === 'ready' ? undefined : asked
    if (attention) ticket.attention = attention
    else delete ticket.attention
    // A replaced or cleared attention question withdraws any pending unsent reply for the previous question from the outbox.
    if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id)
    const pull = report.limit && report.state === 'blocked' ? this.ownPullUrl(ticket) : undefined
    const summary = pull ? `${report.summary}. Work so far: ${pull}` : report.summary
    assignment.report = { state: report.state, summary, at }
    if (report.limit && report.state === 'blocked') assignment.limit = report.limit
    ticket.updatedAt = at
    if (report.title !== undefined) ticket.title = report.title
    if (report.answers &&!ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers]
    if (report.answers) this.takeUp(ticketId, report.answers)
    if (report.state === 'blocked' || report.state === 'failed') ticket.undelivered = ticket.undelivered.filter(id => !automatic(ticket.inputs.find(input => input.id === id)))
    this.repo.tickets.save(ticket)
    if (report.limit && report.state === 'blocked') this.replies.limitStopped(ticket, assignment.id, report.limit, pull)
    // A ticket that follows Threads ends with them: a ready report ends it only once followsDone holds, with that outcome.
    const ready = !ticket.follows?.length ? 'completed' : this.tickets.followsDone(ticket)?.outcome
    // A dropped report after a close the ticket deferred ends it as the close did, which its final notice tells.
    const outcome = report.state === 'dropped' ? this.tickets.followsDone(ticket)?.outcome ?? 'dropped' : report.state === 'ready' ? ready : undefined
    if (outcome) this.tickets.end(ticketId, 'executor', outcome, at)
    return this.require(ticketId)
  }
  /** The web address of the ticket's own thread, from its last own follow: recorded at bind time, else the thread's own address. */
  private ownPullUrl(ticket: Ticket): string | undefined {
    const follow = ticket.follows?.findLast(item => item.own)
    if (!follow) return undefined
    if (typeof follow.url === 'string') return follow.url
    const url = this.repo.threads.get(follow.thread)?.meta.url
    return typeof url === 'string' ? url : undefined
  }
  /** The ticket, while it is open and `assignmentId` runs it. */
  private running(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.require(ticketId)
    return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
}
