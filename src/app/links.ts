// Ported from dsh-superagent-prototype (MIT) src/app/links.ts, with triggerMessage from src/executor/dsh.ts
/**
 * Trigger messages as workers and the Router read them, and the candidate card the Router assesses.
 * Changes from the reference: no source message link lookup (the host has no link reader, so candidate cards carry no
 * source_url beyond the trigger's own URL); `triggerMessage` takes no link and cuts text at TRIGGER_CHARS
 * behind a `trigger/<id>` read; every trigger text is wrapped as external data; the accept mode comes from the settings.
 */
import { threadKey, type Candidate, type Ticket, type Trigger } from '../core/index.ts'
import type { Settings } from '../policy/policy.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { external, preview, relatedTickets, ticketCard, triggerCard } from './cards.ts'
import type { Store } from './store.ts'

export const TRIGGER_CHARS = 600

/** Formats a trigger for a worker or the Router: author, thread, timestamp, text cut at TRIGGER_CHARS, and the message it replies to. */
export function triggerMessage(trigger: Trigger, note?: string, repliesTo?: Trigger) {
  const cut = trigger.text.length > TRIGGER_CHARS ? `${trigger.text.slice(0, TRIGGER_CHARS)}…` : undefined
  return {
    trigger_id: trigger.id,
    from: trigger.actor.id,
    thread: threadKey(trigger.threads[0]!),
    at: trigger.at,
    text: external('trigger', cut ?? trigger.text),
    ...(cut ? { chars: trigger.text.length, read: `trigger/${trigger.id}` } : {}),
    ...(trigger.url ? { source_url: trigger.url } : {}),
    ...(note ? { routing_note: note } : {}),
    ...(repliesTo
      ? { replies_to: { trigger_id: repliesTo.id, preview: external('trigger', preview(repliesTo.text)) } }
      : {}),
  }
}

export interface LinkHost {
  store: Pick<Store, 'triggers' | 'threads' | 'tickets'>
  sources: Pick<SourceRegistry, 'repliesTo' | 'find'>
  settings(): Settings
}

/** The trigger a given trigger replies to, when its Source can tell and the store holds it. */
export function repliedTo(
  host: { store: Pick<Store, 'triggers'>; sources: Pick<SourceRegistry, 'repliesTo'> },
  trigger: Trigger,
): Trigger | undefined {
  const parent = host.sources.repliesTo(trigger)
  return parent === undefined ? undefined : host.store.triggers.get(parent)
}
/** Finds tickets subscribed to threads referenced in `trigger.text` (such as `#12` or URLs) that are not already in `known`. */
function referencedTickets(host: LinkHost, trigger: Trigger, known: readonly Ticket[]): Ticket[] {
  const threads = (trigger.text.match(/#\d+|https?:\/\/[^\s)>\]]+/g) ?? []).flatMap(
    reference => host.sources.find(reference).threads,
  )
  const ids = new Set(threads.flatMap(thread => host.store.threads.get(thread)?.subscriptions ?? []))
  for (const ticket of known) ids.delete(ticket.id)
  return [...ids].flatMap(id => host.store.tickets.get(id) ?? []).slice(0, 4)
}
/** Builds the Router's candidate card with routing metadata, handback history, and related or referenced tickets. */
export function candidateCard(host: LinkHost, candidate: Candidate): Record<string, unknown> {
  const primary = candidate.triggers.at(-1)!
  const delivered = host.store.triggers.disposition(primary.id)?.fanout ?? []
  const referenced = referencedTickets(host, primary, candidate.tickets)
  // Triggers that a worker Session handed back as outside its ticket's scope, with the worker's reason.
  const handedBack = candidate.triggers.flatMap(trigger =>
    (host.store.triggers.disposition(trigger.id)?.handbacks ?? []).map(item => ({
      trigger_id: trigger.id,
      ticket_id: item.ticketId,
      reason: item.reason,
    })),
  )
  // Format the primary trigger like a worker input (including the message it replies to) and summarize earlier batch triggers as cards.
  const others = candidate.triggers.filter(trigger => trigger.id !== primary.id)
  return {
    ...triggerMessage(primary, undefined, repliedTo(host, primary)),
    strength: candidate.strength,
    mode: host.settings().policy.acceptMode,
    ...(others.length ? { batch: others.map(trigger => triggerCard(trigger)) } : {}),
    ...(handedBack.length ? { handed_back: handedBack } : {}),
    ...relatedTickets(candidate.tickets),
    ...(delivered.length ? { delivered_to: delivered } : {}),
    ...(referenced.length ? { referenced_tickets: referenced.map(ticketCard) } : {}),
    next_action:
      candidate.strength === 'explicit'
        ? 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.'
        : 'Ignore it with orchestrator_route if the card shows it touches no enabled rule; else assess it with orchestrator_eval, orchestrator_eval_read, then orchestrator_eval_decide.',
  }
}
