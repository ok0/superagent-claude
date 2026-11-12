import { pathToFileURL } from 'node:url'

export type Status = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT-RUN'
export type AuthMode = 'api-key' | 'subscription'

export interface ItemResult {
  id: string; req: string; title: string;
  status: Status; reason?: string;
  deviation: boolean;
  summary: string;
  observations: string[];
  evidence: string[];
  attempts: number;
  costs: number[][];
  sub?: ItemResult[];
  adrs?: string;
  repro?: string;
}

export interface SpikeItem {
  id: string; req: string; title: string; adrs: string;
  live: boolean; estimateUsd: number;
  run(ctx: SpikeContext): Promise<ItemResult>;
}

export interface SpikeContext {
  auth: { mode: AuthMode; varName: 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN' };
  model: string; tmpRoot: string; configDir: string; homeDir: string; markerDir: string;
  sdkEnv(): Record<string, string>;
  newRepo(name: string): string;
  supports: { maxBudgetUsd: boolean; onFailure: boolean };
  remainingUsd(): number;
  log(line: string): void;
}

export interface RunRecord {
  startedAt: string; finishedAt: string;
  env: { sdkVersion: string; cliVersion: string; cliVersionObserved?: string; node: string; os: string; model: string; budgetCapUsd: number };
  auth: { mode: AuthMode | null; apiKeySource?: string };
  preflight: { live: boolean; problems: string[] };
  items: ItemResult[];
  costModel: 'cumulative' | 'per-turn' | 'unknown';
  isolation: { checked: boolean; notes: string[] };
  exitCode: number;
}

export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1]
  return entry !== undefined && metaUrl === pathToFileURL(entry).href
}
