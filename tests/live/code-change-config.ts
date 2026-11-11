export const LIVE_LIMITS = { max: 2, maxTurns: 200, maxBudgetUsd: 20 } as const
export const LIVE_NETWORK_ALLOW: readonly string[] = ['registry.npmjs.org']

export function liveConfig(o: { repo: string; owner: string; stateDir: string }): Record<string, unknown> {
  return {
    repositories: [o.repo],
    policy: { allowed: [o.owner], acceptMode: 'auto' },
    auth: { mode: 'subscription', owner: o.owner },
    delivery: { allowAutoMerge: false },
    workers: { ...LIVE_LIMITS },
    network: { allow: [...LIVE_NETWORK_ALLOW] },
    stateDir: o.stateDir,
  }
}
