// Ported from dsh-superagent-prototype (MIT) src/app/resources.ts
/**
 * Paginated resources that orchestrator_read serves to the Router session and to a ticket's worker,
 * so large bodies stay out of model prompts until they are requested.
 * The Router session sees `tickets`; the worker sees its own ticket only. `github/…` reads go through the
 * configured GitHub reader, with the repository checked against the configured list.
 * Text bodies of triggers and GitHub originals are wrapped as external data.
 */
import { UserError, key, reached, threadKey, type Ticket, type Trigger } from '../core/index.ts'
import { configured } from '../sources/github/trigger.ts'
import {
  decisionCard,
  external,
  preview,
  textPage,
  threadCard,
  ticketCard,
  ticketDetails,
  triggerCard,
  type TicketThread,
} from './cards.ts'
import type { TextCache } from './cache.ts'
import type { Store } from './store.ts'

/** Resource descriptors exposed via orchestrator_read; the worker reads only its own ticket and what reached it. */
export const RESOURCES: readonly { name: string; holds: string; worker?: true }[] = [
  {
    name: 'tickets',
    holds:
      "ticket cards, newest first; a card's state is person/review after a ready report, person/blocked or person/failed after those reports, person/answer with a question, person/delivery when an input could not reach the worker, working or working/queued while it works, idle once the worker ended its turn without a report, else how the ticket ended",
  },
  {
    name: 'ticket/<id>',
    holds:
      "a ticket's card, the trigger and threads it is tied to, its latest assignments with the start of each report, and its inputs, newest first",
    worker: true,
  },
  {
    name: 'trigger/<id>',
    holds: "a trigger's text, where it went, and the messages around it on its thread",
    worker: true,
  },
  {
    name: 'thread/<key>',
    holds: 'one thread: its label, its tickets and latest decisions, and its triggers, newest first',
    worker: true,
  },
  {
    name: 'github/[<owner>/<name>/]…',
    holds:
      'a GitHub original, such as github/issues/<number>, github/pulls/<number>/comments or github/commits/<sha>/checks; the repository may be omitted when one is configured',
    worker: true,
  },
  {
    name: 'skill/github',
    holds: 'the GitHub skill: how to read the GitHub resources and what their ids mean',
    worker: true,
  },
]
export const resourceGrammar = (worker: boolean): string =>
  RESOURCES.filter(resource => !worker || resource.worker)
    .map(resource => `${resource.name}: ${resource.holds}`)
    .join('; ')

export interface ResourceHost {
  store: Pick<Store, 'tickets' | 'triggers' | 'threads' | 'read' | 'decisions' | 'replyStatus'>
  pages: TextCache
  repositories(): readonly string[]
  repositoryOf(ticket: Ticket): string | undefined
  skill(): string
  github?(repository: string, resource: string, signal?: AbortSignal): Promise<unknown>
}

const text = (resource: string, body: string, offset: number, limit: number | undefined) =>
  textPage(resource, body, offset, limit ?? 4000)
/** Pages a list: `limit` items by default 20 and at most 50, with `next_offset` when more follow. */
function list<T>(offset: number, limit: number | undefined, fetch: (offset: number, count: number) => T[]) {
  const size = Math.min(limit ?? 20, 50)
  const items = fetch(offset, size + 1)
  return { items: items.slice(0, size), next_offset: items.length > size ? offset + size : null }
}
/** Whether a worker's ticket may read a trigger: it reached the ticket, started it, or is on a followed thread. */
const readable = (host: ResourceHost, ticket: Ticket, found: Trigger): boolean =>
  reached(ticket, found, key => host.store.threads.get(key)) ||
  ticket.origin.triggerIds.includes(found.id) ||
  found.threads.some(ref => ticket.follows?.some(follow => follow.thread === threadKey(ref)))
function trigger(host: ResourceHost, id: string, ticketId?: string): Trigger {
  const found = host.store.triggers.get(id)
  if (!found) throw new UserError('unknownTrigger')
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
  if (ticketId && (!ticket || !readable(host, ticket, found))) throw new UserError('notReached')
  return found
}
const triggerLine = (item: Trigger) => ({
  trigger_id: item.id,
  actor: item.actor.id,
  human: item.human,
  at: item.at,
  preview: external('trigger', preview(item.text)),
  chars: item.text.length,
  read: `trigger/${item.id}`,
})
/**
 * The threads a ticket is tied to: those it is subscribed to (context-only ones marked),
 * and those its own source bound it to.
 */
function ticketThreads(host: ResourceHost, ticket: Ticket): TicketThread[] {
  const bound = new Set((ticket.follows ?? []).map(follow => follow.thread))
  const subscribed = host.store.threads.list().filter(item => item.subscriptions.includes(ticket.id))
  const marked = (thread: string, context: boolean): TicketThread => ({
    thread,
    ...(context ? { context: true } : {}),
    ...(bound.has(thread) ? { bound: true } : {}),
  })
  return [
    ...subscribed.map(item => marked(item.key, !!item.context?.includes(ticket.id))),
    ...[...bound].filter(thread => !subscribed.some(item => item.key === thread)).map(thread => marked(thread, false)),
  ]
}
/**
 * Resolves a GitHub resource's repository: explicit in the name, implicit from the ticket (worker),
 * or the one configured repository (Router).
 */
function githubRepository(
  host: ResourceHost,
  resource: string,
  ticketId?: string,
): { repository: string; rest: string } {
  if (/^github\/(issues|pulls|commits)\//.test(resource)) {
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    const repository = ticket
      ? host.repositoryOf(ticket)
      : host.repositories().length === 1
        ? host.repositories()[0]
        : undefined
    if (!repository) throw new Error('Name the repository: github/<owner>/<name>/issues/<number>')
    return { repository, rest: resource.slice('github/'.length) }
  }
  const named = /^github\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(.+)$/.exec(resource)
  if (!named) throw new Error('Unknown GitHub resource')
  return { repository: `${named[1]!}/${named[2]!}`, rest: named[3]! }
}

/**
 * Reads a paginated resource for the Router session (`ticketId` undefined) or a ticket's worker.
 * Unknown names are tool errors.
 * @throws {Error} for a resource the caller may not read or that does not exist;
 * `UserError` for a missing or unreached trigger or ticket.
 */
export async function readResource(
  host: ResourceHost,
  resource: string,
  offset: number,
  limit: number | undefined,
  ticketId?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const worker = ticketId !== undefined
  if (resource === 'tickets') {
    if (worker) throw new Error('This resource belongs to the Router session')
    const tickets = host.store.tickets.list()
    return list(offset, limit, (from, count) => tickets.slice(from, from + count).map(ticketCard))
  }
  if (resource.startsWith('ticket/')) {
    const id = resource.slice('ticket/'.length)
    if (id.includes('/')) throw new Error('Unknown resource')
    if (worker && id !== ticketId) throw new Error('Ticket does not belong to this worker')
    const ticket = host.store.tickets.get(id)
    if (!ticket) throw new UserError('unknownTicket')
    return ticketDetails(ticket, ticketThreads(host, ticket), worker)
  }
  if (resource.startsWith('trigger/')) {
    const id = resource.slice('trigger/'.length)
    if (!id || id.includes('/')) throw new Error('Unknown resource')
    const found = trigger(host, id, ticketId)
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    // A worker sees its own ticket only, and other triggers only where they reached it too.
    const shown = (item: Trigger | undefined) => (item && (!ticket || readable(host, ticket, item)) ? item : undefined)
    const disposition = host.store.triggers.disposition(found.id)
    const visible =
      disposition && ticket
        ? { ...disposition, decisionId: undefined, fanout: disposition.fanout.filter(item => item === ticket.id) }
        : disposition
    // The card omits the preview and self-reference, since this resource returns the full text.
    const { preview: _preview, chars: _chars, read: _read, ...card } = triggerCard(found, visible)
    const neighbours = host.store.read.neighbours(threadKey(found.threads[0]!), found.at, found.id)
    const around = { before: shown(neighbours.before), after: shown(neighbours.after) }
    return {
      ...card,
      acknowledgement: host.store.replyStatus(key('ack', found.id)) ?? 'not_requested',
      ...(offset === 0
        ? {
            around: {
              ...(around.before ? { before: triggerLine(around.before) } : {}),
              ...(around.after ? { after: triggerLine(around.after) } : {}),
            },
          }
        : {}),
      ...text(resource, external('trigger', found.text), offset, limit),
    }
  }
  if (resource.startsWith('thread/')) {
    const threadKeyValue = resource.slice('thread/'.length)
    const thread = host.store.threads.get(threadKeyValue)
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    if (
      !thread ||
      (ticketId !== undefined &&
        !(thread.subscriptions.includes(ticketId) || ticket?.follows?.some(follow => follow.thread === threadKeyValue)))
    ) {
      throw new Error('Unknown or inaccessible thread')
    }
    const { tickets: _ids, read: _read, ...card } = threadCard(thread)
    const page = list(offset, limit, (from, count) =>
      host.store.read.threadPage(thread.key, from, count).map(triggerLine),
    )
    // A worker sees no other tickets or decisions on a shared thread.
    if (worker) return { ...card, ...page }
    const tickets = thread.subscriptions.flatMap(id => {
      const found = host.store.tickets.get(id)
      return found ? [ticketCard(found)] : []
    })
    const decisions = host.store.decisions.byThread(thread.key).slice(-5).reverse().map(decisionCard)
    return { ...card, tickets, decisions, ...page }
  }
  if (resource.startsWith('github/')) {
    if (!host.github) throw new Error('GitHub resources are unavailable in this installation')
    const { repository, rest } = githubRepository(host, resource, ticketId)
    const name = configured(host.repositories(), repository)
    if (!name) throw new Error(`Repository ${repository} is not in the configured repositories`)
    const cacheKey = `${ticketId ?? 'router'}:${resource}`
    let body: string
    if (offset === 0) {
      body = JSON.stringify(await host.github(name, `github/${rest}`, signal))
      host.pages.set(cacheKey, body)
    } else {
      const cached = host.pages.get(cacheKey)
      if (cached === undefined) throw new Error('Read this GitHub resource from offset 0 first')
      body = cached
    }
    return text(resource, external('github', body), offset, limit)
  }
  if (resource === 'skill/github') return text(resource, host.skill(), offset, limit)
  throw new Error(`Unknown resource; use one of: ${resourceGrammar(worker)}`)
}
