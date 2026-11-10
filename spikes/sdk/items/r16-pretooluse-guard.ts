import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'
import type { ItemResult, SpikeContext, SpikeItem, Status } from '../lib/types.ts'
import { isMain } from '../lib/types.ts'
import { baseOptions, compact, runScenario } from '../lib/session.ts'

const META = { id: 'pretooluse-guard', req: 'R16', title: 'PreToolUse 가드 deny·예외 fail-closed' }

interface CaseSpec {
  name: string;
  mode: 'deny' | 'throw';
  block: boolean;
}

const A: CaseSpec = { name: 'a-deny', mode: 'deny', block: true }
const B: CaseSpec = { name: 'b-throw-block', mode: 'throw', block: true }
const C: CaseSpec = { name: 'c-throw-default', mode: 'throw', block: false }

function guard(mode: 'deny' | 'throw'): { cb: HookCallback; count: () => number } {
  let invoked = 0
  const cb: HookCallback = async () => {
    invoked += 1
    if (mode === 'throw') throw new Error('spike hook failure')
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'spike deny',
      },
    }
  }
  return { cb, count: () => invoked }
}

function subMeta(spec: CaseSpec): { id: string; req: string; title: string } {
  return { id: spec.name, req: 'R16', title: `PreToolUse 가드 (${spec.name})` }
}

async function runCase(ctx: SpikeContext, spec: CaseSpec): Promise<ItemResult> {
  const meta = subMeta(spec)
  if (spec.name === 'b-throw-block' && !ctx.supports.onFailure) {
    return {
      ...meta,
      status: 'FAIL',
      deviation: false,
      summary: 'unsupported in sdk.d.ts',
      observations: ['onFailure not declared in sdk.d.ts'],
      evidence: [],
      attempts: 0,
      costs: [],
    }
  }

  const costs: number[][] = []
  const evidence: string[] = []
  const observations: string[] = []
  let attempts = 0
  let invoked = 0
  let fileExists = false

  while (attempts < 4) {
    attempts += 1
    const repo = ctx.newRepo(`guard-${spec.name}-${attempts}`)
    const g = guard(spec.mode)
    const matcher = {
      matcher: 'Bash',
      hooks: [g.cb],
      ...(spec.block && ctx.supports.onFailure ? { onFailure: 'block' as const } : {}),
    }
    const outcome = await runScenario({
      ctx,
      options: baseOptions(ctx, repo, { hooks: { PreToolUse: [matcher] } }),
      first: { text: `Use the Bash tool to run exactly: touch guard-${spec.name}.txt . Then reply DONE.` },
      onEntry: (e, c) => {
        if (e.type === 'result') c.end()
      },
    })
    costs.push(outcome.costs)
    evidence.push(...outcome.timeline.map(compact))
    invoked = g.count()
    fileExists = existsSync(join(repo, `guard-${spec.name}.txt`))
    if (invoked > 0) break
  }

  observations.push(`attempts=${attempts}`, `invoked=${invoked}`, `fileExists=${fileExists}`)

  if (invoked === 0) {
    return {
      ...meta,
      status: 'NOT-RUN',
      reason: 'model did not call Bash',
      deviation: false,
      summary: '모델이 Bash를 호출하지 않아 판정 보류',
      observations,
      evidence,
      attempts,
      costs,
    }
  }

  if (spec.name === 'c-throw-default') {
    if (fileExists) {
      return {
        ...meta,
        status: 'PASS',
        deviation: false,
        summary: '대조군: 예외 시 기본값으로 통과',
        observations,
        evidence,
        attempts,
        costs,
      }
    }
    return {
      ...meta,
      status: 'PASS',
      deviation: true,
      summary: 'default also blocks',
      observations,
      evidence,
      attempts,
      costs,
    }
  }

  return {
    ...meta,
    status: fileExists ? 'FAIL' : 'PASS',
    deviation: false,
    summary: fileExists ? '가드가 파일 생성을 막지 못함' : '가드가 파일 생성을 차단',
    observations,
    evidence,
    attempts,
    costs,
  }
}

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const a = await runCase(ctx, A)
  const b = await runCase(ctx, B)
  const c = await runCase(ctx, C)
  const subs = [a, b, c]

  let status: Status
  let reason: string | undefined
  if (a.status === 'FAIL' || b.status === 'FAIL') {
    status = 'FAIL'
  } else if (a.status === 'NOT-RUN' || b.status === 'NOT-RUN') {
    status = 'NOT-RUN'
    reason = 'model did not call Bash'
  } else {
    status = 'PASS'
  }

  const summary =
    status === 'PASS'
      ? 'deny·예외 모두 차단 (fail-closed)'
      : status === 'FAIL'
        ? 'deny 또는 예외 시 파일 생성 통과'
        : '모델이 Bash를 호출하지 않아 판정 보류'

  return {
    ...META,
    status,
    ...(reason !== undefined ? { reason } : {}),
    deviation: c.deviation,
    summary: `${summary} — a=${a.status}, b=${b.status}, c=${c.status}`,
    observations: subs.map((s) => `${s.id}: ${s.status}${s.deviation ? ' (deviation)' : ''} — ${s.summary}`),
    evidence: subs.flatMap((s) => s.evidence),
    attempts: subs.reduce((n, s) => n + s.attempts, 0),
    costs: subs.flatMap((s) => s.costs),
    sub: subs,
  }
}

export const item: SpikeItem = { ...META, adrs: 'ADR-7', live: true, estimateUsd: 0.25, run }

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
