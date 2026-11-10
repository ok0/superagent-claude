// Ported from dsh-superagent-prototype (MIT) src/kv.ts
/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 * Changes from the reference: only the store, runtime, sessions and sources families are kept; the families of the removed components are dropped; the health snapshot key is added.
 */

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

import type { HealthSnapshot } from '../infra/health.ts'

export const KV = {
  /** Runtime health: the HealthBoard snapshot the daemon writes each pass (at most every 5s) and the status CLI reads. */
  health: { snapshot: record<HealthSnapshot>('health') },
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Runtime: the Router session's ID and the prompt version it was opened under. */
  runtime: { masterId: record<string>('master-id'), routerPrompt: record<string>('router-prompt-version') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Per-Source resolved display names mapping a named ID (such as a chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
}
