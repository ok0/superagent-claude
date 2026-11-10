// Ported from dsh-superagent-prototype (MIT) src/sources/kind.ts
/** SourceKind plugin contract: configuration schema, listening scope, reply channel, bounded thread context reader, search and reply lookups, policy notes and execution environment. Changes from the reference: the display members (title, description, facts, form fields), the health entry list, label refresh, channel links, image reading and the command runner parameter are removed; text fields are plain strings. */
import type { z } from 'zod'
import type { OutboundMessage, ScopeResult, Trigger } from '../core/index.ts'

export interface VariableSpec { key: string; description: string }
export interface EnvironmentInput<C> { config: C; trigger?: Trigger }
export interface AdmissionRowView { id: string; label: string; note: string }
/** What the kind marks as addressed to the agent, which an allowed sender's explicit request requires, and its receiving scopes for the admission table. */
export interface SourcePolicyPart<C> {
  explicit: string
  rows?(config: C): AdmissionRowView[]
}
/** Outbound reply adapter for a kind's threads. */
export interface SourceChannel<C> {
  /** Whether a reply may still go to `address`; without it, every address may receive replies. */
  allowed?(address: Record<string, string>, config: C): boolean
  /**
   * Sends a message idempotently by ID; returns `'gone'` when the target conversation no longer accepts replies.
   * @throws when delivery failed but may succeed on a later retry.
   */
  send(message: OutboundMessage): Promise<'sent' | 'gone'>
}
/** Normalized message returned by thread context readers; `bot` marks a non-human sender whose message can never authorize work on its own (at most an inferred candidate). */
export interface ContextMessage {
  id: string; from: string; at: string; text: string
  bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number
}
export type ContextPartName = 'thread' | 'root' | 'parent'
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }
/** Bounded thread context reader used by assessments to inspect messages around a trigger. */
export interface ThreadContext<C> {
  /** The ID of the Trigger's own message among the messages of its Thread. */
  messageId(trigger: Trigger): string
  /** Reads a page of thread messages (`thread`, first page when `cursor` is omitted), the topic root (`root`), or the replied-to message (`parent`). */
  read(trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
}
export interface TriggerContext {
  readonly messageId: string
  read(part: ContextPartName, cursor?: string): Promise<ContextPart>
}
/** Pluggable source kind descriptor registered with SourceRegistry. */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable ID; a default instance with the same ID exists when none is stored. */
  kind: string
  /** Validates stored and submitted configuration and fills defaults. */
  schema: z.ZodType<C>
  /** Listening rule for a trigger (or recorded Mandate basis) of this kind; kinds without `scope` listen to everything they produce and observe none of it. */
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  /** Outbound reply adapter; kinds without `channel` produce no replies or channel checks. */
  channel?: SourceChannel<C>
  /** Bounded context reader for assessments; assessments of a kind without `threadContext` read none. */
  threadContext?: ThreadContext<C>
  /** Maps a search query to candidate Thread keys (such as `chat:12`) and Trigger search terms. */
  find?(query: string): { threads: string[]; terms: string[] }
  /** Returns the ID of the Trigger whose message this Trigger replies to, when derivable without a network read. */
  repliesTo?(trigger: Trigger): string | undefined
  /** Policy notes for the kind's Triggers and its admission table rows. */
  policy?: SourcePolicyPart<C>
  /** Variables the kind registers with the execution environment and how their values are computed. */
  environment?: { variables: readonly VariableSpec[]; values(input: EnvironmentInput<C>): Record<string, string> }
}

export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }
