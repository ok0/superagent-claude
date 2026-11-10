// Ported from dsh-superagent-prototype (MIT) src/app/assessment.ts
/**
 * Proactive candidate assessment for the Router session: relays candidate cards, serves bounded context reads, and records outcomes.
 * Changes from the reference: the Router session is the only assessor (the deterministic one stays in the Runtime); the
 * repository, image and file reads are removed (D4; GitHub originals are read through orchestrator_read); the thread window is
 * loaded through the kind's TriggerContext with no command runner; every text a read or the context returns is wrapped as
 * external data; the checked-IM-text step is removed.
 */
import { z } from 'zod'
import { reasonText, threadKey, type Assessor, type AssessmentOutcome, type Candidate, type EngineForMainSession, type Trigger } from '../core/index.ts'
import { AdmissionDirectionSchema, RuleAssessmentSchema, assessmentOutcome, directionAllowed, type Settings } from '../policy/policy.ts'
import { admissionContext } from '../sources/admission-context.ts'
import type { ContextPartName, TriggerContext } from '../sources/kind.ts'
import { external, relatedTickets, textPage } from './cards.ts'
import type { Effects } from './effects.ts'
import { AcknowledgementSchema } from './tools/tool.ts'

/** Schema for a short lowercase kebab-case English ticket worktree name (1–4 words, at most 32 characters). */
export const WorktreeNameSchema = z.string().max(32)
  .regex(/^[a-z]+(?:-[a-z0-9]+){0,3}$/, 'Use 1–4 short English words in lowercase kebab-case, at most 32 characters')
  .describe('Meaningful short English ticket name, e.g. fix-plan-color. 1–4 lowercase words in kebab-case, at most 32 characters.')
/** The fields of the Router's assessment decision (`orchestrator_eval_decide`), before the cross-field rule. */
export const AssessmentFields = z.object({
  decision: z.enum(['accept', 'ignore', 'unavailable']),
  rule_assessments: z.array(RuleAssessmentSchema)
    .refine(assessments => new Set(assessments.map(assessment => assessment.rule_id)).size === assessments.length,
      'Duplicate rule assessment IDs').describe('One per enabled rule.'),
  direction: AdmissionDirectionSchema.describe('Required for every decision.'),
  title: z.string().min(1).max(160),
  worktree_name: WorktreeNameSchema.optional(),
  scope: z.string().max(1500),
  intent_evidence: z.string().trim().min(1).max(700).nullish().describe('For acceptance: the quotes that establish the three facts.'),
  acknowledgement: AcknowledgementSchema.nullish().describe('For acceptance: one sentence in the source language, posted as a reply to the trigger; omit only when a matched rule asks for silence.'),
  reason: z.string().min(1).max(500),
}).strict()
/** Schema for the Router session's proactive candidate assessment decision (`orchestrator_eval_decide`). */
export const AssessmentSchema = AssessmentFields.refine(value => value.decision !== 'accept' || !directionAllowed(value.direction)
  || !value.rule_assessments.some(rule => rule.matched) || !!value.worktree_name, { message: 'Accepted work requires a short English worktree_name', path: ['worktree_name'] })

/** Character limits in the initial thread window: for the trigger itself, its two nearest neighbours, other window messages, and stub previews. */
const TRIGGER_CHARS = 4000, NEAR_CHARS = 1200, WINDOW_CHARS = 400, STUB_CHARS = 50
/** Pages of the thread loaded for the initial window. */
const CONTEXT_PAGES = 5
const FINISHED = 'This assessment has finished: it was decided, timed out or restarted'
const EXPLICIT = 'This is an explicit request, which is routed instead of assessed: use orchestrator_route with its trigger_id and kind accept, attach, stop or ignore'
/** Message returned when assessing a Trigger whose Source provides no thread context. */
const NO_CONTEXT = 'This Source gives no Thread context; assess the Trigger\'s own text and the batch.'
type AdmissionContext = Awaited<ReturnType<typeof admissionContext>>
interface ReadCache { snapshots: Map<string, string>; messages: Map<string, string>; cursors: Set<string> }
/** Per-evaluation state kept while an Eval runs: served reads cache, loaded thread context (or error), and any in-flight initial load. */
interface EvalReads { cache: ReadCache; context?: AdmissionContext; error?: string; loading?: Promise<void> }
/** Host dependencies used by `MasterAssessor`. */
export interface AssessorHost {
  /** Active evaluations in `Engine` that the assessor reads and decides. */
  engine(): Pick<EngineForMainSession, 'candidate' | 'candidateDelivered' | 'decide'>
  /** Durable effect queue through which candidate assessments are delivered. */
  effects: Pick<Effects, 'enqueue' | 'handle' | 'cancel'>
  settings(): Settings
  /** Whether processing is paused, which holds candidate deliveries. */
  paused(): boolean
  /** Thread context reader for `trigger`'s Source, or `undefined` when the Source has none. */
  threadContext(trigger: Trigger): TriggerContext | undefined
  /** Delivers a candidate card to the Router session once per request ID, resolving after the session receives it. */
  deliver(requestId: string, text: string): Promise<void>
  candidateCard(candidate: Candidate): Record<string, unknown>
}

/** Fields of `orchestrator_eval_read`: a message, the root, the parent, or a page of the thread. */
export const EvalReadFields = z.object({
  trigger_id: z.string().min(1).describe('Original candidate ID returned by orchestrator_eval; every reference is scoped to this trigger.'),
  resource: z.enum(['message', 'root', 'parent', 'thread']),
  message_id: z.string().optional().describe('Only for message: omit for the trigger, or the id of a window message or stub.'),
  cursor: z.string().optional().describe('Only for thread: omit on the first page, then the next_cursor of the window or the cursor of next_read. Never a thread or message ID.'),
  offset: z.number().int().min(0).default(0).describe('Text pagination: copy next_offset; keep the other arguments unchanged.'),
}).strict()
/** Schema for bounded context requests during an active evaluation (`orchestrator_eval_read`). */
export const EvalReadSchema = EvalReadFields.superRefine((read, ctx) => {
  if (read.message_id !== undefined && read.resource !== 'message') ctx.addIssue({ code: 'custom', message: 'message_id is only for message.' })
  if (read.cursor !== undefined && read.resource !== 'thread') ctx.addIssue({ code: 'custom', message: 'cursor is only for thread. First page: {resource:"thread"}.' })
})
/** Validated arguments for `MasterAssessor.read`. */
export type EvalRead = z.infer<typeof EvalReadSchema>
/** Cuts a text to `limit` characters and wraps it as external data from `source`; the cut length is reported with `chars`. */
function cut(text: string, limit: number, source: string): { text: string } | { text: string; chars: number } {
  return text.length <= limit ? { text: external(source, text) } : { text: external(source, `${text.slice(0, limit)}…`), chars: text.length }
}

/**
 * Implements the `Engine` `Assessor` port for proactive candidate evaluation in the Router session.
 * Relays each evaluation's candidate card to the Router session through the durable `assessment` effect, serves bounded thread
 * context reads while the evaluation runs, and converts the Router's assessment into an `AssessmentOutcome` for `Engine.decide`.
 * The Router's `orchestrator_eval*` tools call `context`, `read`, and `decide`.
 */
export class MasterAssessor implements Assessor {
  /** Per-evaluation read caches and thread contexts, keyed by `evalId`. */
  private readonly evals = new Map<string, EvalReads>()
  private readonly host: AssessorHost
  /** Registers the handler that relays each Eval's candidate card, which a busy Router session may delay. */
  constructor(host: AssessorHost) {
    this.host = host
    // Start the evaluation deadline only after the Router session receives the candidate card, so a busy session does not consume evaluation time.
    host.effects.handle('assessment', async ({ triggerId }, evalId) => {
      const candidate = this.host.engine().candidate(triggerId)
      if (candidate?.evalId !== evalId) return
      await this.host.deliver(`candidate:${evalId}`, JSON.stringify({ kind: 'candidate', ...this.host.candidateCard(candidate) }))
      this.host.engine().candidateDelivered(evalId)
    }, { limit: () => host.paused() ? 0 : 4 })
  }
  /** Enqueues an `assessment` effect to deliver `candidate`'s card to the Router session. */
  request(candidate: Candidate): void { this.host.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id }) }
  /** Whether `evalId` is still the active evaluation for `trigger`. */
  private live(evalId: string, trigger: Trigger): boolean { return this.host.engine().candidate(trigger.id)?.evalId === evalId }
  /** Drop an Eval's context and reads once it finishes; any running load for it discards its result. */
  release(evalId: string): void {
    this.evals.delete(evalId)
    this.host.effects.cancel('assessment', evalId)
  }
  /** Resolve the active evaluation for a trigger; historical triggers have none, and explicit requests are routed instead. */
  private evalFor(triggerId: string): { candidate: Candidate; trigger: Trigger } {
    const candidate = this.host.engine().candidate(triggerId)
    if (!candidate) throw new Error('No assessment is in progress for this trigger; it was already decided, timed out, or never reached assessment')
    if (candidate.strength === 'explicit') throw new Error(EXPLICIT)
    const trigger = candidate.triggers.find(item => item.id === triggerId)!
    return { candidate, trigger }
  }
  /** Returns or initializes the read cache for `evalId`, seeded with the trigger's own message; throws if `evalId` has finished. */
  private reads(evalId: string, trigger: Trigger): EvalReads {
    let reads = this.evals.get(evalId)
    if (!reads) {
      // Reject reads after the evaluation ends so completed evaluations do not retain cached state.
      if (!this.live(evalId, trigger)) throw new Error(FINISHED)
      const context = this.host.threadContext(trigger)
      reads = { cache: { snapshots: new Map(), messages: new Map([[context?.messageId ?? '', trigger.text]]), cursors: new Set() } }
      this.evals.set(evalId, reads)
    }
    return reads
  }
  /** Loads and caches the initial bounded thread window once per evaluation. */
  private async seed(evalId: string, trigger: Trigger, caller?: AbortSignal): Promise<void> {
    caller?.throwIfAborted()
    const reads = this.reads(evalId, trigger)
    if (reads.context || reads.error !== undefined) return
    const thread = this.host.threadContext(trigger)
    if (!thread) { reads.error = NO_CONTEXT; return }
    let loading = reads.loading
    if (!loading) {
      // Guard against concurrent completion or replacement while async context loading is running.
      const current = () => this.evals.get(evalId)?.loading === loading
      // Defer start until `reads.loading` is assigned below so `current()` holds from the first step.
      loading = Promise.resolve().then(async () => {
        try {
          const context = await admissionContext(thread, CONTEXT_PAGES)
          if (!current()) return
          reads.context = context
          // Allow pagination to continue from the end of the initial window.
          if (context.next) reads.cache.cursors.add(context.next)
          for (const message of context.messages) if (!message.deleted) reads.cache.messages.set(message.id, message.text)
        } catch (error) {
          if (current()) reads.error = `Thread context unavailable: ${String(error).slice(0, 300)}. Use orchestrator_eval_read before deciding based on missing context.`
        }
      }).finally(() => { if (current()) delete reads.loading })
      reads.loading = loading
    }
    await loading
    caller?.throwIfAborted()
    if (!this.live(evalId, trigger)) throw new Error(FINISHED)
  }
  /**
   * Returns the `orchestrator_eval` payload: the trigger's text once (up to `TRIGGER_CHARS`), batch peers, related tickets on
   * the thread, the Policy version its Eval was built from, and the initial thread window (the first five messages and five on
   * either side of the trigger, cut to `WINDOW_CHARS` or `NEAR_CHARS` for its two nearest neighbours, with other loaded messages
   * as `STUB_CHARS` previews; `orchestrator_eval_read` reads any message in full by ID).
   * Assessment instructions live in the Router's prompt, not in this payload.
   */
  async context(triggerId: string, signal?: AbortSignal) {
    const { candidate, trigger } = this.evalFor(triggerId)
    await this.seed(candidate.evalId, trigger, signal)
    const { context, error } = this.evals.get(candidate.evalId) ?? {}
    const source = this.host.threadContext(trigger)
    const thread = context ? (() => {
      const shown = new Map(context.window.entries.map(entry => [entry.message.id, entry]))
      const at = context.messages.findIndex(message => message.id === source?.messageId)
      const messages = context.messages.map((message, index) => {
        const author = { id: message.id, from: message.from, ...message.bot ? { bot: true } : {} }
        if (message.deleted) return { ...author, deleted: true }
        if (!shown.has(message.id)) return { ...author, preview: external('thread', message.text.replace(/\s+/g, ' ').slice(0, STUB_CHARS)) }
        // The trigger's own text is already included once at the top level.
        if (index === at) return { ...author, at: message.at, trigger: true }
        const near = at >= 0 && Math.abs(index - at) <= 2
        return { ...author, at: message.at, ...cut(message.text, near ? NEAR_CHARS : WINDOW_CHARS, 'thread') }
      })
      return { complete: context.complete, loaded_messages: context.messages.length, source_found: context.window.source_found,
        ...context.next ? { next_cursor: context.next } : {}, messages }
    })() : { error: error ?? 'Call orchestrator_eval to load initial context', complete: false }
    const settings = this.host.settings()
    const others = candidate.triggers.filter(item => item.id !== trigger.id)
    return { trigger_id: trigger.id, strength: candidate.strength, mode: settings.policy.acceptMode,
      source: { kind: trigger.source, actor: trigger.actor.id, thread: threadKey(trigger.threads[0]!), ...(trigger.url ? { url: trigger.url } : {}) },
      ...cut(trigger.text, TRIGGER_CHARS, 'trigger'),
      ...others.length ? { batch: others.map(item => {
        const body = cut(item.text, WINDOW_CHARS, 'trigger')
        return { trigger_id: item.id, actor: item.actor.id, at: item.at, ...body, ...'chars' in body ? { read: `trigger/${item.id}` } : {} }
      }) } : {},
      ...relatedTickets(candidate.tickets), policy_version: candidate.policyVersion,
      thread }
  }
  /** Serves a bounded, paginated read of the evaluation's message, root, parent, or thread page for `orchestrator_eval_read`. */
  async read(read: EvalRead, signal?: AbortSignal) {
    const { candidate, trigger } = this.evalFor(read.trigger_id)
    await this.seed(candidate.evalId, trigger, signal)
    const { cache } = this.reads(candidate.evalId, trigger)
    const { snapshots, messages, cursors } = cache
    const source = this.host.threadContext(trigger)
    const cacheKey = JSON.stringify([read.resource, read.cursor, read.message_id])
    if (read.offset > 0) {
      const cached = snapshots.get(cacheKey)
      if (cached === undefined) throw new Error('Read this resource at offset 0 first')
      return textPage(read.resource, cached, read.offset, 4000)
    }
    let body: string
    if (read.resource === 'message') {
      const message = messages.get(read.message_id ?? source?.messageId ?? '')
      if (message === undefined) throw new Error('Unknown message reference. Use resource=root/parent or read the thread first; copy a returned message read call.')
      body = external('thread', message)
    } else {
      if (!source) throw new Error(NO_CONTEXT)
      if (read.cursor !== undefined && !cursors.has(read.cursor)) throw new Error('Unknown thread cursor. First call {resource:"thread"}; then copy the returned next_read exactly.')
      const part: ContextPartName = read.resource
      const result = await source.read(part, read.cursor)
      for (const message of result.messages) if (!message.deleted) messages.set(message.id, message.text)
      if (result.next) cursors.add(result.next)
      const next = result.next ? { trigger_id: trigger.id, resource: 'thread', cursor: result.next } : null
      body = JSON.stringify({ next_read: next, ...result.body, messages: result.messages.map(message => message.deleted
        ? { id: message.id, from: message.from, deleted: true } : { ...message, text: external('thread', message.text) }) })
    }
    snapshots.set(cacheKey, body)
    return textPage(read.resource, body, read.offset, 4000)
  }
  /** Converts the assessment into an outcome under current settings and passes it to `Engine.decide` for policy verification. */
  async decide(triggerId: string, result: z.infer<typeof AssessmentSchema>, signal?: AbortSignal): Promise<{ state: string; ticket_id?: string; reason: string }> {
    const { candidate } = this.evalFor(triggerId)
    signal?.throwIfAborted()
    const outcome: AssessmentOutcome = assessmentOutcome(result, this.host.settings(), candidate.strength)
    const decision = this.host.engine().decide(triggerId, { ...outcome, evalId: candidate.evalId })
    return { state: decision.kind, ...(decision.ticketId ? { ticket_id: decision.ticketId } : {}), reason: reasonText(decision.reason) }
  }
  /** Drops every evaluation's context and reads when the runtime stops. */
  stop(): void { this.evals.clear() }
}
