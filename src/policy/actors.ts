/**
 * Actor and repository admission (charter R30, R37): whether a Trigger may enter the Engine at all.
 * Reads only the Trigger's structured actor, its `human` flag and `meta.repository`, never its text, and takes no authentication mode.
 */
import type { Trigger } from '../core/model.ts'

export type ActorVerdict = 'allowed' | 'source-fact' | 'rejected-actor' | 'rejected-bot' | 'rejected-repo'
/** The global allowed list of logins and the configured repositories (`owner/name`), both compared without case. */
export interface ActorRule { allowed: readonly string[]; repositories: readonly string[] }

/** Compare two logins or repository names without case; no other normalisation (spec A3). */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const BOT_SUFFIX = /\[bot\]$/i
/** A bot: the Source marked the Trigger as not written by a person (an account type other than a user, CI, or this agent), or the login ends in `[bot]`. */
export const isBot = (trigger: Pick<Trigger, 'human' | 'actor'>): boolean => !trigger.human || BOT_SUFFIX.test(trigger.actor.id)

/**
 * Judge a Trigger's actor and repository, in order: a repository outside `repositories` (or none) is `rejected-repo`; an empty
 * actor id (a CI transition) is a `source-fact`; an actor not on `allowed` is `rejected-bot` or `rejected-actor`; anyone else,
 * a bot named on the list included, is `allowed` (the gate still treats such a bot as inferred).
 */
export function actorVerdict(trigger: Trigger, rule: ActorRule): ActorVerdict {
  const repository = trigger.meta.repository
  if (typeof repository !== 'string' || !rule.repositories.some(name => sameName(name, repository))) return 'rejected-repo'
  if (trigger.actor.id === '') return 'source-fact'
  if (!rule.allowed.some(login => sameName(login, trigger.actor.id))) return isBot(trigger) ? 'rejected-bot' : 'rejected-actor'
  return 'allowed'
}
