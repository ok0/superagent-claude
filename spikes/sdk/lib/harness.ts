import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSdkEnv, resolveAuth, SUPPLY_HINT } from './auth.ts'
import { mask, scanForSecrets, secretValues } from './mask.ts'
import { renderReport } from './report.ts'
import type { ItemResult, RunRecord, SpikeContext, SpikeItem } from './types.ts'

export interface HarnessOptions {
  items: SpikeItem[];
  out?: string;
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export const EXIT = { OK: 0, FAIL: 1, INTERNAL: 2, NO_CREDENTIAL: 3, REFUSED: 4, BUDGET: 5, LEAK: 6 } as const

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SDK_DIR = join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
const LEAK_DOC = '# SDK 시맨틱 스파이크 결과\n\n생성 중단: 비밀 검출\n'

interface SdkInfo {
  sdkVersion: string;
  cliVersion: string;
  supports: { maxBudgetUsd: boolean; onFailure: boolean };
}

function readSdkInfo(): SdkInfo {
  const pkg = JSON.parse(readFileSync(join(SDK_DIR, 'package.json'), 'utf8')) as {
    version?: string;
    claudeCodeVersion?: string;
  };
  const dts = readFileSync(join(SDK_DIR, 'sdk.d.ts'), 'utf8');
  return {
    sdkVersion: pkg.version ?? 'unknown',
    cliVersion: pkg.claudeCodeVersion ?? 'unknown',
    supports: { maxBudgetUsd: /maxBudgetUsd/.test(dts), onFailure: /onFailure/.test(dts) },
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitStatus(): string[] {
  return git(ROOT, ['status', '--porcelain']).split('\n').filter((line) => line !== '');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function blockedResult(item: SpikeItem, reason: string, summary: string): ItemResult {
  return {
    id: item.id, req: item.req, title: item.title,
    status: 'BLOCKED', reason, summary, deviation: false,
    observations: [], evidence: [], attempts: 0, costs: [], adrs: item.adrs,
  };
}

async function runOne(item: SpikeItem, ctx: SpikeContext): Promise<ItemResult> {
  try {
    return { ...(await item.run(ctx)), adrs: item.adrs };
  } catch (error) {
    return {
      id: item.id, req: item.req, title: item.title,
      status: 'FAIL', summary: `internal error: ${errorText(error)}`, deviation: false,
      observations: [], evidence: [], attempts: 0, costs: [], adrs: item.adrs,
    };
  }
}

function stubContext(info: SdkInfo, log: (line: string) => void): SpikeContext {
  const refuse = (): never => {
    throw new Error('live-only context used without a credential');
  };
  return {
    get auth(): SpikeContext['auth'] {
      return refuse();
    },
    model: '', tmpRoot: '', configDir: '', homeDir: '', markerDir: '',
    sdkEnv: refuse,
    newRepo: refuse,
    supports: info.supports,
    remainingUsd: refuse,
    log,
  };
}

function obsValue(items: ItemResult[], key: string): string | undefined {
  for (const item of items) {
    const hit = item.observations.find((line) => line.startsWith(`${key}=`));
    if (hit !== undefined) return hit.slice(key.length + 1);
    if (item.sub !== undefined) {
      const nested = obsValue(item.sub, key);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function resolveCostModel(results: ItemResult[]): RunRecord['costModel'] {
  const value = obsValue(results.filter((r) => r.id === 'result'), 'costModel');
  return value === 'cumulative' || value === 'per-turn' ? value : 'unknown';
}

function exitCodeOf(results: ItemResult[]): number {
  if (results.some((r) => r.status === 'BLOCKED' && r.reason === 'budget')) return EXIT.BUDGET;
  if (results.some((r) => r.status === 'BLOCKED' && r.reason === 'no-credential')) return EXIT.NO_CREDENTIAL;
  if (results.some((r) => r.status === 'FAIL')) return EXIT.FAIL;
  return EXIT.OK;
}

function checkIsolation(
  tmpRoot: string,
  configDir: string,
  outRel: string | undefined,
  gitBefore: string[],
): RunRecord['isolation'] {
  const notes: string[] = [];
  const projectsDir = join(os.homedir(), '.claude', 'projects');
  if (existsSync(projectsDir)) {
    const hit = readdirSync(projectsDir).some((name) => name.includes(basename(tmpRoot)));
    notes.push(`홈 ~/.claude/projects 에 spike tmp root 항목: ${hit ? '있음' : '없음'}`);
  } else {
    notes.push('홈 ~/.claude/projects 에 spike tmp root 항목: 없음');
  }
  const configProjects = join(configDir, 'projects');
  const populated = existsSync(configProjects) && readdirSync(configProjects).length > 0;
  notes.push(`격리 config dir 세션 존재(positive control): ${populated ? '예' : '아니오'}`);
  const ignore = (line: string): boolean => outRel !== undefined && line.slice(3) === outRel;
  const before = gitBefore.filter((line) => !ignore(line));
  const after = gitStatus().filter((line) => !ignore(line));
  const same = before.length === after.length && before.every((line, index) => line === after[index]);
  notes.push(`git status --porcelain (출력 경로 제외) 실행 전후 동일: ${same ? '예' : '아니오'}`);
  return { checked: true, notes };
}

export async function execute(o: HarnessOptions): Promise<number> {
  const secrets = secretValues(o.env);
  const emitLine = (text: string): void => o.stdout(mask(text, secrets) + '\n');
  const emitErr = (text: string): void => o.stderr(mask(text, secrets) + '\n');
  const startedAt = new Date().toISOString();
  const auth = resolveAuth(o.env);

  if (auth.kind === 'refused') {
    for (const problem of auth.problems) emitErr(problem);
    emitErr(SUPPLY_HINT);
    return EXIT.REFUSED;
  }

  const info = readSdkInfo();
  const budgetCap = Number(o.env['SPIKE_BUDGET_USD'] ?? 5);
  const model = o.env['SPIKE_MODEL'] ?? 'haiku';
  const outAbs = o.out === undefined ? undefined : resolve(o.out);
  const results: ItemResult[] = [];
  let isolation: RunRecord['isolation'] = { checked: false, notes: [] };

  if (auth.kind === 'missing') {
    emitErr('live 항목 미실행:');
    for (const problem of auth.problems) emitErr(`  - ${problem}`);
    emitErr(SUPPLY_HINT);
    const stub = stubContext(info, emitErr);
    for (const item of o.items) {
      const result = item.live
        ? blockedResult(item, 'no-credential', '크레덴셜/live 게이트 미충족')
        : await runOne(item, stub);
      results.push(result);
      emitLine(JSON.stringify(result));
    }
  } else {
    const tmpRoot = mkdtempSync(join(os.tmpdir(), 'sac-spike-'));
    const configDir = join(tmpRoot, 'claude-config');
    const homeDir = join(tmpRoot, 'home');
    const markerDir = join(tmpRoot, 'markers');
    for (const dir of [configDir, homeDir, markerDir]) mkdirSync(dir, { recursive: true });
    let spent = 0;
    const newRepo = (name: string): string => {
      const repo = join(tmpRoot, 'repos', name);
      mkdirSync(join(tmpRoot, 'repos'), { recursive: true });
      git(tmpRoot, ['init', '-q', repo]);
      git(repo, ['config', 'user.name', 'spike']);
      git(repo, ['config', 'user.email', 'spike@example.invalid']);
      git(repo, ['config', 'core.hooksPath', '/dev/null']);
      git(repo, ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'spike init']);
      return repo;
    };
    const ctx: SpikeContext = {
      auth: { mode: auth.mode, varName: auth.varName },
      model, tmpRoot, configDir, homeDir, markerDir,
      sdkEnv: () => buildSdkEnv(auth, o.env, { configDir, homeDir, tmpDir: tmpRoot }),
      newRepo,
      supports: info.supports,
      remainingUsd: () => budgetCap - spent,
      log: emitErr,
    };
    const gitBefore = gitStatus();
    try {
      let budgetHit = false;
      for (const item of o.items) {
        let result: ItemResult;
        if (item.live && (budgetHit || spent + item.estimateUsd > budgetCap)) {
          budgetHit = true;
          result = blockedResult(item, 'budget', '예산 상한 도달 — 실행하지 않음');
        } else {
          result = await runOne(item, ctx);
        }
        spent += sum(result.costs.flat());
        results.push(result);
        emitLine(JSON.stringify(result));
      }
      isolation = checkIsolation(
        tmpRoot,
        configDir,
        outAbs === undefined ? undefined : relative(ROOT, outAbs),
        gitBefore,
      );
    } finally {
      if (o.env['SPIKE_KEEP_TMP'] !== '1') rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  const exitCode = exitCodeOf(results);
  const record: RunRecord = {
    startedAt,
    finishedAt: new Date().toISOString(),
    env: {
      sdkVersion: info.sdkVersion,
      cliVersion: info.cliVersion,
      cliVersionObserved: obsValue(results, 'cliVersion'),
      node: process.version,
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      model,
      budgetCapUsd: budgetCap,
    },
    auth: {
      mode: auth.kind === 'ok' ? auth.mode : null,
      apiKeySource: obsValue(results, 'apiKeySource'),
    },
    preflight: {
      live: auth.kind === 'ok',
      problems: auth.kind === 'missing' ? auth.problems : [],
    },
    items: results,
    costModel: resolveCostModel(results),
    isolation,
    exitCode,
  };

  if (outAbs === undefined) return exitCode;
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, mask(renderReport(record), secrets));
  const findings = scanForSecrets(readFileSync(outAbs, 'utf8'), secrets);
  if (findings.length > 0) {
    writeFileSync(outAbs, LEAK_DOC);
    for (const finding of findings) emitErr(finding);
    return EXIT.LEAK;
  }
  return exitCode;
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}
