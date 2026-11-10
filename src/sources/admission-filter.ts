/**
 * AdmissionFilter: the check every Trigger passes before Passes.receive. It admits a Trigger whose actor is on the allowed list and whose repository is configured, or a Source fact on a Thread of an open ticket whose mandate actor is allowed; every other Trigger is recorded as rejected and never reaches the Engine. It reads only the actor, the human flag, `meta.repository` and the store, never the text, and takes no authentication mode.
 */
import { threadKey, type EngineForSources, type ReceiveResult, type Trigger } from '../core/index.ts'
import { actorVerdict, sameName, type ActorRule } from '../policy/actors.ts'
import type { RejectedTrigger, RejectionReason, Store } from '../app/store.ts'

export interface AdmissionFilterDeps {
  /** Where an admitted Trigger goes (the Runtime passes Passes.receive, which calls Engine.receive). */
  next(trigger: Trigger): ReceiveResult
  store: Pick<Store, 'threads' | 'tickets' | 'rejected'>
  /** The current allowed list and repositories; read on every Trigger so a reload applies to the next one. */
  rule(): ActorRule
  /** Called once per newly recorded rejection. */
  rejected?(entry: RejectedTrigger): void
}

export class AdmissionFilter implements Pick<EngineForSources, 'receive'> {
  private readonly deps: AdmissionFilterDeps
  constructor(deps: AdmissionFilterDeps) { this.deps = deps }

  receive(trigger: Trigger): ReceiveResult {
    const rule = this.deps.rule()
    const verdict = actorVerdict(trigger, rule)
    if (verdict === 'allowed') return this.deps.next(trigger)
    if (verdict === 'source-fact' && this.followed(trigger, rule.allowed)) return this.deps.next(trigger)
    const reason: RejectionReason = verdict === 'source-fact' ? 'no-ticket' : verdict
    const entry: RejectedTrigger = {
      triggerId: trigger.id,
      repository: typeof trigger.meta.repository === 'string' ? trigger.meta.repository : '',
      actor: trigger.actor.id,
      at: trigger.at,
      reason,
    }
    if (this.deps.store.rejected.record(entry)) this.deps.rejected?.(entry)
    return 'filtered'
  }

  /** True when some ref of the Trigger's Threads is subscribed by an open ticket whose mandate actor is allowed. */
  private followed(trigger: Trigger, allowed: readonly string[]): boolean {
    const { store } = this.deps
    return trigger.threads.some(ref => {
      const thread = store.threads.get(threadKey(ref))
      return !!thread && thread.subscriptions.some(id => {
        const ticket = store.tickets.get(id)
        return !!ticket && !ticket.ended && allowed.some(login => sameName(login, ticket.mandate.actor.id))
      })
    })
  }
}
