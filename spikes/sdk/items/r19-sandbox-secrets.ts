import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HookCallback, SandboxSettings } from '@anthropic-ai/claude-agent-sdk'
import type { ItemResult, SpikeContext, SpikeItem, Status } from '../lib/types.ts'
import { isMain } from '../lib/types.ts'
import { baseOptions, compact, field, runScenario, type TimelineEntry } from '../lib/session.ts'

const META = { id: 'sandbox-secrets', req: 'R19', title: '샌드박스 네트워크·크레덴셜 가시성·예산 상한' }
const NET_CMD =
  "curl -sS -m 10 -o /dev/null -w 'HTTP:%{http_code}\\n' https://example.com ; curl -sS -m 10 -o /dev/null -w 'HTTP:%{http_code}\\n' https://www.iana.org"
const SANDBOX: SandboxSettings = {
  enabled: true,
  allowUnsandboxedCommands: false,
  network: { allowedDomains: ['example.com'] },
}

interface NetOutcome {
  sub: ItemResult
  sandboxLive?: boolean
  costs: number[][]
  evidence: string[]
}

export function spikeSandbox(env: Readonly<Record<string, string | undefined>> = process.env): SandboxSettings {
  return {
    ...SANDBOX,
    ...(env.SANDBOX_WEAKER_NESTED === '1'
      ? { enableWeakerNestedSandbox: true, filesystem: { denyRead: ['/proc'] } }
      : {}),
  }
}

function stopAtResult(e: TimelineEntry, c: { end(): void }): void {
  if (e.type === 'result') c.end()
}

function toolOutputs(entries: TimelineEntry[]): string[] {
  return entries.flatMap(e => (e.toolResults ?? []).map(r => r.content))
}

function httpCodes(entries: TimelineEntry[]): string[] {
  return toolOutputs(entries).flatMap(text => [...text.matchAll(/HTTP:(\d{3})/g)].map(m => m[1] ?? ''))
}

function reachable(code: string | undefined): boolean {
  return code !== undefined && /^[23]\d\d$/.test(code)
}

export function staticSandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') return existsSync('/usr/bin/sandbox-exec')
  if (platform === 'linux') return spawnSync('sh', ['-c', 'command -v bwrap && command -v socat']).status === 0
  return false
}

export function networkStatus(o: {
  sandbox: readonly string[]
  control: readonly string[]
  staticAvailable: boolean
  sandboxLive: boolean
}): { status: Status; reason?: string } {
  const [s1, s2] = o.sandbox
  const [c1, c2] = o.control
  if (reachable(c1) && reachable(c2) && reachable(s1) && !reachable(s2)) return { status: 'PASS' }
  if (!reachable(c1) || !reachable(c2)) return { status: 'BLOCKED', reason: 'no-network' }
  if (!o.staticAvailable || !o.sandboxLive) return { status: 'BLOCKED', reason: 'sandbox-unavailable' }
  if (reachable(s2)) return { status: 'FAIL' }
  return { status: 'BLOCKED', reason: 'sandbox-unavailable' }
}

function visibilityOf(entries: TimelineEntry[]): 'PRESENT' | 'ABSENT' | 'unknown' {
  const text = toolOutputs(entries).join('\n')
  if (text.includes('SPIKE_VAR_PRESENT')) return 'PRESENT'
  if (text.includes('SPIKE_VAR_ABSENT')) return 'ABSENT'
  return 'unknown'
}

function notRun(id: string, reason: string): NetOutcome {
  return {
    sub: {
      id,
      req: 'R19',
      title: `샌드박스 네트워크 (${id})`,
      status: 'NOT-RUN',
      reason,
      deviation: false,
      summary: reason,
      observations: [],
      evidence: [],
      attempts: 0,
      costs: [],
    },
    costs: [],
    evidence: [],
  }
}

async function networkTest(ctx: SpikeContext, id: string): Promise<NetOutcome> {
  const prompt = `Use the Bash tool to run exactly this command and nothing else: ${NET_CMD} . Then reply DONE.`
  const sandboxed = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo(`${id}-sandbox`), {
      sandbox: { ...spikeSandbox(), autoAllowBashIfSandboxed: true },
      permissionMode: 'dontAsk',
      allowDangerouslySkipPermissions: false,
      allowedTools: ['Bash'],
    }),
    first: { text: prompt },
    onEntry: stopAtResult,
  })
  const control = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo(`${id}-control`), {
      permissionMode: 'dontAsk',
      allowDangerouslySkipPermissions: false,
      allowedTools: ['Bash'],
    }),
    first: { text: prompt },
    onEntry: stopAtResult,
  })
  const bypass = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo(`${id}-bypass`), { sandbox: spikeSandbox() }),
    first: { text: prompt },
    onEntry: stopAtResult,
  })

  const sb = httpCodes(sandboxed.timeline)
  const ct = httpCodes(control.timeline)
  const bp = httpCodes(bypass.timeline)
  const hasToolResult = sandboxed.timeline.some(e => (e.toolResults ?? []).length > 0)
  const unavailable = toolOutputs(sandboxed.timeline).some(text =>
    /sandbox[^\n]*(unavailable|not available)|bwrap:|bubblewrap/i.test(text),
  )
  const sandboxLive = hasToolResult && !unavailable

  const net = networkStatus({
    sandbox: sb,
    control: ct,
    staticAvailable: staticSandboxAvailable(),
    sandboxLive,
  })

  const evidence = [
    ...sandboxed.timeline.map(compact),
    ...control.timeline.map(compact),
    ...bypass.timeline.map(compact),
  ]
  return {
    sub: {
      id,
      req: 'R19',
      title: `샌드박스 네트워크 (${id})`,
      status: net.status,
      ...(net.reason ? { reason: net.reason } : {}),
      deviation: false,
      summary:
        net.status === 'PASS'
          ? 'sandbox: example.com 허용·iana.org 차단, 대조군 양쪽 도달'
          : net.status === 'BLOCKED'
            ? `BLOCKED (${net.reason}): sandbox codes=${sb.join(',') || 'none'}, control codes=${ct.join(',') || 'none'}`
            : `sandbox codes=${sb.join(',') || 'none'}, control codes=${ct.join(',') || 'none'}`,
      observations: [
        `sandbox codes=${sb.join(',') || 'none'}`,
        `control codes=${ct.join(',') || 'none'}`,
        `sandboxLive=${sandboxLive}`,
        `static=${staticSandboxAvailable()}`,
        `bypass-mode codes=${bp.join(',') || 'none'}`,
      ],
      evidence,
      attempts: 1,
      costs: [],
    },
    sandboxLive,
    costs: [sandboxed.costs, control.costs, bypass.costs],
    evidence,
  }
}

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const costs: number[][] = []
  const evidence: string[] = []

  const macOut =
    process.platform === 'darwin' ? await networkTest(ctx, 'a-network-macos') : notRun('a-network-macos', 'not macOS')
  const linuxOut =
    process.platform === 'linux'
      ? await networkTest(ctx, 'a-network-linux')
      : notRun('a-network-linux', 'Linux 환경 없음 — M11/M19 전 실측 필요')
  costs.push(...macOut.costs, ...linuxOut.costs)
  evidence.push(...macOut.evidence, ...linuxOut.evidence)

  const varName = ctx.auth.varName
  const CHECK = 'if [ -n "${' + varName + '+x}" ]; then echo SPIKE_VAR_PRESENT; else echo SPIKE_VAR_ABSENT; fi'
  const visPrompt = `Use the Bash tool to run exactly this command and nothing else: ${CHECK} . Then reply DONE.`

  const scrub: HookCallback = async input => {
    const raw = field(input, 'tool_input')
    const toolInput: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {}
    const command = typeof toolInput.command === 'string' ? toolInput.command : ''
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...toolInput, command: `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; ${command}` },
      },
    }
  }
  const scrubMatcher = {
    matcher: 'Bash',
    hooks: [scrub],
    ...(ctx.supports.onFailure ? { onFailure: 'block' as const } : {}),
  }

  const v1Out = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo('visibility-plain')),
    first: { text: visPrompt },
    onEntry: stopAtResult,
  })
  const v2Out = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo('visibility-sandbox'), { sandbox: SANDBOX }),
    first: { text: visPrompt },
    onEntry: stopAtResult,
  })
  const v3Out = await runScenario({
    ctx,
    options: baseOptions(ctx, ctx.newRepo('visibility-scrub'), {
      hooks: { PreToolUse: [scrubMatcher] },
    }),
    first: { text: visPrompt },
    onEntry: stopAtResult,
  })
  const v1 = visibilityOf(v1Out.timeline)
  const v2 = visibilityOf(v2Out.timeline)
  const v3 = visibilityOf(v3Out.timeline)
  const bCosts = [v1Out.costs, v2Out.costs, v3Out.costs]
  costs.push(...bCosts)
  evidence.push(...v1Out.timeline.map(compact), ...v2Out.timeline.map(compact), ...v3Out.timeline.map(compact))

  const bFail = v3 !== 'ABSENT'
  const bSub: ItemResult = {
    id: 'b-secret-visibility',
    req: 'R19',
    title: '크레덴셜 환경변수 가시성',
    status: bFail ? 'FAIL' : 'PASS',
    deviation: v1 === 'PRESENT',
    summary: bFail
      ? v3 === 'PRESENT'
        ? 'scrub 훅 후에도 변수 가시'
        : 'PreToolUse 검사 출력 없음'
      : v1 === 'PRESENT'
        ? '기본 상태에서 변수 가시 → scrub 훅 필요'
        : '기본 상태에서도 변수 비가시',
    observations: [`default=${v1}`, `sandbox=${v2}`, `scrub-hook=${v3}`],
    evidence: [],
    attempts: 1,
    costs: [],
  }

  const staticAvailable = staticSandboxAvailable()
  const sandboxLive = macOut.sandboxLive ?? linuxOut.sandboxLive
  let cSub: ItemResult
  if (sandboxLive === undefined) {
    cSub = {
      id: 'c-probe',
      req: 'R19',
      title: '샌드박스 가용성 프로브',
      status: 'NOT-RUN',
      reason: 'sandboxed session not run',
      deviation: false,
      summary: '샌드박스 세션 미실행으로 비교 불가',
      observations: [`static=${staticAvailable}`, 'unavailable case not reproducible on this host'],
      evidence: [],
      attempts: 0,
      costs: [],
    }
  } else {
    const consistent = staticAvailable === sandboxLive
    const blockedProbe = linuxOut.sub.status === 'BLOCKED' || macOut.sub.status === 'BLOCKED'
    cSub = {
      id: 'c-probe',
      req: 'R19',
      title: '샌드박스 가용성 프로브',
      status: consistent ? 'PASS' : blockedProbe ? 'BLOCKED' : 'FAIL',
      ...(!consistent && blockedProbe ? { reason: 'sandbox-unavailable' } : {}),
      deviation: false,
      summary: consistent
        ? '정적 프로브와 실측 샌드박스 가용성 일치'
        : blockedProbe
          ? '정적 프로브와 실측 불일치 — 샌드박스 불가 환경'
          : '정적 프로브와 실측 샌드박스 가용성 불일치',
      observations: [
        `static=${staticAvailable}`,
        `live=${sandboxLive}`,
        'unavailable case not reproducible on this host',
      ],
      evidence: [],
      attempts: 1,
      costs: [],
    }
  }

  let dSub: ItemResult
  if (!ctx.supports.maxBudgetUsd) {
    dSub = {
      id: 'd-max-budget',
      req: 'R19',
      title: 'maxBudgetUsd 상한 동작',
      status: 'FAIL',
      deviation: false,
      summary: 'unsupported in sdk.d.ts',
      observations: ['maxBudgetUsd not declared in sdk.d.ts'],
      evidence: [],
      attempts: 0,
      costs: [],
    }
  } else {
    const dOut = await runScenario({
      ctx,
      options: baseOptions(ctx, ctx.newRepo('max-budget'), { maxBudgetUsd: 0.0001 }),
      first: { text: 'Use the Bash tool to run: echo 1 . Then run: echo 2 . Then reply DONE.' },
      onEntry: stopAtResult,
    })
    costs.push(dOut.costs)
    evidence.push(...dOut.timeline.map(compact))
    const subtype = dOut.results.at(-1)?.result?.subtype ?? 'none'
    const ok = subtype.startsWith('error_') && subtype.includes('budget')
    dSub = {
      id: 'd-max-budget',
      req: 'R19',
      title: 'maxBudgetUsd 상한 동작',
      status: ok ? 'PASS' : 'FAIL',
      deviation: false,
      summary: ok ? '예산 상한 도달 시 budget 오류 종료' : `예산 상한 결과 subtype=${subtype}`,
      observations: [`subtype=${subtype}`],
      evidence: [],
      attempts: 1,
      costs: [],
    }
  }

  const subs = [macOut.sub, linuxOut.sub, bSub, cSub, dSub]
  const failedIds = [macOut.sub, linuxOut.sub, cSub, dSub, bSub].filter(s => s.status === 'FAIL').map(s => s.id)
  const blockedIds = subs.filter(s => s.status === 'BLOCKED').map(s => s.id)
  const status: Status = failedIds.length > 0 ? 'FAIL' : blockedIds.length > 0 ? 'BLOCKED' : 'PASS'

  return {
    ...META,
    status,
    ...(status === 'BLOCKED' ? { reason: 'sandbox-unavailable' } : {}),
    deviation: bSub.deviation,
    summary:
      status === 'PASS'
        ? '샌드박스 네트워크·크레덴셜 가시성(scrub)·예산 상한 확인'
        : status === 'BLOCKED'
          ? `BLOCKED 하위 항목: ${blockedIds.join(', ')}`
          : `FAIL 하위 항목: ${failedIds.join(', ')}`,
    observations: subs.map(s => `${s.id}: ${s.status}${s.deviation ? ' (deviation)' : ''} — ${s.summary}`),
    evidence,
    attempts: 1,
    costs,
    sub: subs,
  }
}

export const item: SpikeItem = { ...META, adrs: 'ADR-7, ADR-6', live: true, estimateUsd: 0.5, run }

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
