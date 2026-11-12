/**
 * Reads only the Trigger's structured actor, its `human` flag and `meta.repository`, never its text, and
 * takes no authentication mode.
 */
import type { Trigger } from '../core/model.ts'

export type ActorVerdict = 'allowed' | 'source-fact' | 'rejected-actor' | 'rejected-bot' | 'rejected-repo'
/** The global allowed list of logins and the configured repositories (`owner/name`), both compared without case. */
export interface ActorRule {
  allowed: readonly string[]
  repositories: readonly string[]
}

/** Compare two logins or repository names without case; no other normalisation. */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const BOT_SUFFIX = /\[bot\]$/i
export const isBot = (trigger: Pick<Trigger, 'human' | 'actor'>): boolean =>
  !trigger.human || BOT_SUFFIX.test(trigger.actor.id)

/** A bot named on the list is `allowed` here; the gate still admits it only as an inferred candidate. */
export function actorVerdict(trigger: Trigger, rule: ActorRule): ActorVerdict {
  const repository = trigger.meta.repository
  if (typeof repository !== 'string' || !rule.repositories.some(name => sameName(name, repository)))
    return 'rejected-repo'
  if (trigger.actor.id === '') return 'source-fact'
  if (!rule.allowed.some(login => sameName(login, trigger.actor.id)))
    return isBot(trigger) ? 'rejected-bot' : 'rejected-actor'
  return 'allowed'
}
