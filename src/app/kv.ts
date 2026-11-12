// Ported from dsh-superagent-prototype (MIT) src/kv.ts
/**
 * Typed key-value store keys and key families, grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here, so each key is spelled once with its value type.
 */

export type Key<V> = string & { readonly __value?: V }
/** Callable to build a key from its name parts; exposes `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
export function family<V, A extends unknown[] = [string]>(
  prefix: string,
  format = (...name: A) => name.join(':'),
): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

import type { HealthSnapshot } from '../infra/health.ts'
import type { ReviewState } from './review.ts'

/** The readiness marker the daemon writes once started: its pid and when it became ready. */
export interface RuntimeReady {
  pid: number
  at: string
}

export const KV = {
  /**
   * Runtime health: the HealthBoard snapshot the daemon writes each pass (at most every 5 s),
   * read by the status CLI.
   */
  health: { snapshot: record<HealthSnapshot>('health') },
  store: { schema: record<number>('schema') },
  /**
   * Runtime: the Router session's ID and the prompt version it was opened under, and the readiness marker
   * the daemon writes once started and deletes first on stop (`health --ready`).
   */
  runtime: {
    masterId: record<string>('master-id'),
    routerPrompt: record<string>('router-prompt-version'),
    ready: record<RuntimeReady>('runtime-ready'),
  },
  /**
   * Sessions: prompt revisions each Session has worked under, oldest first.
   * The last entry (`.at(-1)`) is its active revision.
   */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Reviews: per-Ticket pre-publish review state (count, last reviewed HEAD, pending review), written by Reviews. */
  review: { state: family<ReviewState, [ticketId: string]>('review:') },
  /** Per-Source resolved display names mapping a named ID (such as a chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
}
