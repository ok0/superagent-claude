export const LIVE_LIMITS = { max: 2, maxTurns: 300, maxBudgetUsd: 30 } as const
export const LIVE_WAIT = {
  pullPerRoundMs: 2_400_000,
  stepMs: 30_000,
  settleMs: 300_000,
  settleCapMs: 1_800_000,
  judgePerFlowMs: 1_800_000,
  replyGraceMs: 900_000,
} as const
export function pullWaitMs(flows: number): number {
  return LIVE_WAIT.pullPerRoundMs * Math.max(1, Math.ceil(flows / LIVE_LIMITS.max))
}
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
