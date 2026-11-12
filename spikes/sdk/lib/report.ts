import type { ItemResult, RunRecord, Status } from './types.ts'

export const ADR_RULES: Record<string, { pass: string; deviation: string; fail: string }> = {
  steer: {
    pass: "steer=priority:'next' 같은 턴 반영 확인 → 입력 전달 결정 Decision 확정, 대체안 미채택.",
    deviation: '같은 턴 미반영·다음 턴 반영 → 입력 전달 결정 대체안(steer→followup 강등, inputsRead=다음 턴 시작(UserPromptSubmit)) 채택. 개정 요청: 입력 전달 결정 Decision 및 L3c runtime.ts 설명.',
    fail: '입력 반영·처리 안 됨 → 대체안 채택 + 앱 큐 전달 검토. 개정 요청: 입력 전달 결정을 새 결정으로 대체.',
  },
  'inputs-read': {
    pass: 'user_message_uuid 에코로 inputsRead 근사 확정.',
    deviation: '에코 시점이 읽음과 불일치 → inputsRead를 UserPromptSubmit/PostToolBatch 훅 기준으로 개정 요청(입력 전달 결정, events.ts).',
    fail: '에코 없음 → 훅 기준 inputsRead 대체 채택, 입력 전달 결정·events.ts 개정 요청.',
  },
  'later-inject': {
    pass: "followup=priority:'later', inject=shouldQuery:false 확정.",
    deviation: '동작은 하나 병합·전달 시점이 다름 → 입력 전달 결정 Consequences 보완 요청.',
    fail: '매핑 불가 → followup=앱 큐(턴 종료 후 전송), inject=다음 입력 텍스트 병합으로 대체, 입력 전달 결정 개정 요청.',
  },
  interrupt: {
    pass: 'still_queued 영수증과 이후 처리 확인 → 재전송 금지(id 장부) 유지.',
    deviation: 'still_queued 메시지가 interrupt 후 처리되지 않음 → 재전송 필요, 입력 전달 결정 Consequences 개정 요청.',
    fail: '영수증 없음 → interrupt 전 대기 입력을 앱 큐에 보류하도록 입력 전달 결정 개정 요청.',
  },
  result: {
    pass: 'subtype·total_cost_usd·num_turns 의미 확인 → 결과·예산 결정 유지, 누적/턴별 결론을 events.ts turnEnded 매핑에 반영.',
    deviation: 'maxTurns가 세션 누적 단위로 적용 → SDK maxTurns 보조 설정 산정 방식 개정 요청(결과·예산 결정).',
    fail: 'error_max_turns 유도 불가 또는 값 부재 → 호스트 단독 강제, SDK 보조 설정 제거 개정 요청(결과·예산 결정).',
  },
  'background-bash': {
    pass: 'run_in_background 즉시 반환 + task-notification 후속 턴 확인 → 입력 전달 결정 백그라운드 결정 확정.',
    deviation: '후속 턴 도착 시점·스키마 상이 → turnEnded 판정 규칙 개정 요청(입력 전달 결정).',
    fail: '후속 턴 없음 → 백그라운드 완료 감지 대체 설계(backgroundTasks/폴링) 필요, 입력 전달 결정 개정 요청.',
  },
  resume: {
    pass: 'resume 시 변경 systemPrompt 반영 → resume 결정 Decision 확정.',
    deviation: 'resume 시 첫 프롬프트 재사용 → resume 결정 개정 요청: resume 후 notice inject로 최신 팀 섹션 전달, 강제 적용은 새 세션.',
    fail: '같은 cwd resume에서 기억 상실 → resume 결정 및 recovery 재개 설계 개정 요청.',
  },
  'pretooluse-guard': {
    pass: 'deny·예외 모두 차단(fail-closed) 확인 → 가드·격리 결정 가드 유지.',
    deviation: '대조군(onFailure 미지정)도 차단 → 기본값 차이 기록, 설계 영향 없음.',
    fail: '예외 시 통과 또는 deny 무시 → 가드 콜백 내부 try/catch로 deny 반환 규칙 추가, 가드·격리 결정 개정 요청.',
  },
  'disallowed-tools': {
    pass: 'disallowedTools로 도구 제거 확인 → 가드·격리 결정·options.ts 유지.',
    deviation: '제거 확인, AskUserQuestion은 헤드리스 기본 미제공(disallow 중복, 무해) → 가드·격리 결정 유지.',
    fail: '제거 안 됨 → PreToolUse 가드로 해당 도구 deny 추가, 가드·격리 결정 개정 요청.',
  },
  'setting-sources': {
    pass: 'settingSources:[]에서 저장소 hook·.mcp.json 비실행, 대조군 실행 확인 → 가드·격리 결정 유지.',
    deviation: '일부만 확인 → 미확인 경로 추가 격리 요청.',
    fail: '실행됨 또는 대조군 무효 → worktree의 .claude/·.mcp.json 격리 조치 추가, 가드·격리 결정 개정 요청.',
  },
  'sandbox-secrets': {
    pass: '샌드박스 네트워크 차단/allow, probe 일치, maxBudgetUsd 지원 확인 → 가드·격리 결정·결과·예산 결정 유지.',
    deviation: '워커 Bash에서 크레덴셜 env 가시 → env 제거 훅을 기본 가드에 추가하도록 가드·격리 결정 개정 요청(우회 가능성 명시).',
    fail: '차단 실패 또는 maxBudgetUsd 미지원 → 샌드박스 불가 취급(auto 거부 규칙) 또는 결과·예산 결정 SDK 예산 보조 설정 제거 개정 요청.',
  },
  version: {
    pass: '최소 요구 충족.',
    deviation: '',
    fail: '요구 미충족 → 고정 버전 재선정 필요.',
  },
}

const SANDBOX_SUB_FAIL: Record<string, string> = {
  'a-network-macos': '네트워크 allowlist 차단 실패, 가드·격리 결정 영향 검토',
  'a-network-linux': '네트워크 allowlist 차단 실패, 가드·격리 결정 영향 검토',
  'b-secret-visibility': '크레덴셜 가시',
  'c-probe': 'probe 불일치',
  'd-max-budget': 'maxBudgetUsd 미지원',
}
const SANDBOX_FINDING =
  '관측: 샌드박스 네트워크 allowlist는 permissionMode가 bypassPermissions가 아닐 때만 비허용 도메인을 차단한다(bypass에서는 ask가 자동 허용). 구현은 bypassPermissions와 네트워크 샌드박스 의존을 결합하지 않고, dontAsk + 명시 allow 목록 또는 canUseTool deny를 사용한다. 가드·격리 결정 개정 노트 요청.'
const PENDING_RULE = "판정 보류 — live 실행 후 재생성 필요"
const ADR5_IDS = ['steer', 'inputs-read', 'later-inject', 'interrupt', 'background-bash']
const NOT_MEASURED_LIMITS = [
  'Linux 샌드박스 미측정: 샌드박스 적용 전에 실측이 필요하다.',
  '모델 행동 항목은 3회 시도 다수결이므로 재현성이 낮다.',
  '샌드박스 불가 케이스는 macOS에서 재현할 수 없다.',
  'SDK 버전은 1개만 측정했다.',
  'Hook 기반 env 제거는 모델이 우회할 수 있다.',
  '제품명 문구는 증거에서 claude-code로 치환되었다.',
]
const SUBSCRIPTION_NOTICE = '구독 크레덴셜 자동화는 약관 회색지대이며 본 스파이크는 소유자 본인의 단일 호스트·1회성 측정이다.'

function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

function statusCell(item: ItemResult): string {
  const status: Status = item.status
  if (status === 'PASS') return item.deviation ? 'PASS(의미 차이)' : 'PASS'
  if (status === 'BLOCKED') return `BLOCKED(${item.reason ?? ''})`
  if (status === 'NOT-RUN') return `NOT-RUN(${item.reason ?? ''})`
  return 'FAIL'
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0)
}

function conservativeOf(item: ItemResult): number {
  return sum(item.costs.flat())
}

function adjustedOf(item: ItemResult, model: RunRecord['costModel']): number {
  if (model === 'cumulative') {
    return item.costs.reduce((acc, session) => acc + (session.length > 0 ? Math.max(...session) : 0), 0)
  }
  return conservativeOf(item)
}

function money(value: number): string {
  return value.toFixed(4)
}

function renderSub(sub: ItemResult, depth: number): string[] {
  const pad = '  '.repeat(depth)
  const lines = [`${pad}- ${sub.id}: ${statusCell(sub)} — ${sub.summary}`]
  for (const obs of sub.observations) lines.push(`${pad}  - ${obs.replace(/\r?\n/g, ' ')}`)
  for (const child of sub.sub ?? []) lines.push(...renderSub(child, depth + 1))
  return lines
}

function reproCommand(id: string): string {
  return id === 'version' ? 'pnpm spike:sdk --only version' : `SUPERAGENT_CLAUDE_LIVE=1 pnpm spike:sdk --only ${id}`
}

function findItem(run: RunRecord, id: string): ItemResult | undefined {
  return run.items.find((item) => item.id === id)
}

function adr5Conclusion(run: RunRecord): string {
  const found = ADR5_IDS.map((id) => findItem(run, id))
  const flagged = ADR5_IDS.filter((id, index) => {
    const item = found[index]
    return item !== undefined && (item.deviation || item.status === 'FAIL')
  })
  if (flagged.length > 0) return `대체안 채택(${flagged.join(', ')})`
  const allPass = found.every((item) => item !== undefined && item.status === 'PASS' && !item.deviation)
  return allPass ? '확정' : '보류'
}

function adr10Conclusion(run: RunRecord): string {
  const resume = findItem(run, 'resume')
  if (resume === undefined) return '보류'
  if (resume.status === 'FAIL') return 'FAIL'
  if (resume.status === 'PASS') {
    return resume.deviation ? '첫 프롬프트 재사용 → 개정 요청' : 'resume 시 변경 systemPrompt 반영'
  }
  return '보류'
}

function failRuleOf(item: ItemResult, fallback: string): string {
  if (item.id === 'disallowed-tools' && item.summary === 'control invalid') return '측정 무효, ADR 영향 없음, 재측정'
  if (item.id === 'sandbox-secrets') {
    const failed = (item.sub ?? []).filter((sub) => sub.status === 'FAIL')
    if (failed.length > 0) return failed.map((sub) => `${sub.id}: ${SANDBOX_SUB_FAIL[sub.id] ?? sub.summary}`).join('; ')
  }
  return fallback
}

export function renderReport(run: RunRecord): string {
  const out: string[] = []
  const line = (text = ''): void => {
    out.push(text)
  }

  line('# SDK 시맨틱 스파이크 결과')
  line()
  line('이 파일은 `pnpm spike:sdk`로 생성된다. 직접 편집한 내용은 다음 실행 시 덮어써진다.')
  line()

  line('## 실행 환경')
  line()
  line(`- SDK 버전: ${run.env.sdkVersion}`)
  const observedCli = run.env.cliVersionObserved
  line(`- CLI 버전: ${run.env.cliVersion}${observedCli !== undefined ? ` (init 관측 claude_code_version: ${observedCli})` : ''}`)
  line(`- Node: ${run.env.node}`)
  line(`- OS: ${run.env.os}`)
  line(`- 실행 시각: ${run.startedAt} ~ ${run.finishedAt}`)
  line(`- 모델: ${run.env.model}`)
  line(`- 예산 상한: ${run.env.budgetCapUsd} USD`)
  line(`- 크레덴셜 모드: ${run.auth.mode ?? '없음(no-credential)'}`)
  if (run.auth.apiKeySource !== undefined) line(`- apiKeySource(관측): ${run.auth.apiKeySource}`)
  if (run.auth.mode === 'subscription') {
    line()
    line(SUBSCRIPTION_NOTICE)
  }
  line()

  line('## 사전 점검')
  line()
  line(`- live: ${run.preflight.live ? 'true' : 'false'}`)
  for (const problem of run.preflight.problems) line(`- ${problem}`)
  line()

  line('## 항목 요약')
  line()
  line('| 항목 ID | 영역 | 상태 | 한 줄 결과 |')
  line('| --- | --- | --- | --- |')
  for (const item of run.items) {
    line(`| ${item.id} | ${item.req} | ${statusCell(item)} | ${cell(item.summary)} |`)
  }
  line()

  line('## 항목별 상세')
  line()
  for (const item of run.items) {
    line(`### ${item.id} (${item.req}) — ${item.title}`)
    line()
    line(`- 상태: ${statusCell(item)}`)
    line(`- 시도 횟수: ${item.attempts}`)
    line('- 관측:')
    if (item.observations.length === 0) line('  - (없음)')
    for (const obs of item.observations) line(`  - ${obs.replace(/\r?\n/g, ' ')}`)
    line(`- 판정 근거: ${item.summary}`)
    if (item.costs.length === 0) {
      line('- 비용: 없음')
    } else {
      const perSession = item.costs.map((session, index) => `세션 ${index + 1} [${session.join(', ')}]`)
      line(`- 비용(세션별, USD): ${perSession.join('; ')}`)
    }
    line(`- 재현: \`${item.repro ?? reproCommand(item.id)}\``)
    if (item.sub !== undefined && item.sub.length > 0) {
      line('- 세부 결과:')
      for (const sub of item.sub) for (const subLine of renderSub(sub, 1)) line(subLine)
    }
    line('- 증거:')
    line()
    line('```text')
    const shown = item.evidence.slice(0, 40)
    for (const ev of shown) line(ev)
    if (item.evidence.length > 40) line(`... (${item.evidence.length - 40}줄 생략)`)
    if (shown.length === 0) line('(없음)')
    line('```')
    line()
  }

  line('## 비용')
  line()
  line('| 항목 ID | 보수적 합계(USD) | 조정 합계(USD) |')
  line('| --- | --- | --- |')
  for (const item of run.items) {
    line(`| ${item.id} | ${money(conservativeOf(item))} | ${money(adjustedOf(item, run.costModel))} |`)
  }
  const conservativeTotal = sum(run.items.map(conservativeOf))
  const adjustedTotal = sum(run.items.map((item) => adjustedOf(item, run.costModel)))
  line()
  line(`- 전체 보수적 합계: ${money(conservativeTotal)} USD`)
  line(`- 전체 조정 합계 (costModel=${run.costModel}): ${money(adjustedTotal)} USD`)
  const cap = run.env.budgetCapUsd
  const budgetBlocked = run.items.some((item) => item.status === 'BLOCKED' && item.reason === 'budget')
  const over = conservativeTotal > cap || budgetBlocked
  if (!over) {
    line(`- 상한 ${cap} USD 대비: 이하`)
  } else {
    const reasons: string[] = []
    if (conservativeTotal > cap) reasons.push('보수적 합계가 상한 초과')
    if (budgetBlocked) reasons.push('예산 소진으로 BLOCKED(budget) 항목 존재')
    line(`- 상한 ${cap} USD 대비: 초과(사유: ${reasons.join(', ')})`)
  }
  line()

  line('## 격리 확인')
  line()
  line(`- 확인 수행: ${run.isolation.checked ? '예' : '아니오'}`)
  for (const note of run.isolation.notes) line(`- ${note}`)
  line()

  line('## ADR 영향')
  line()
  for (const item of run.items) {
    const rules = ADR_RULES[item.id]
    let rule: string
    if (item.status === 'PASS') {
      rule = rules === undefined ? '' : item.deviation ? rules.deviation : rules.pass
    } else if (item.status === 'FAIL') {
      rule = failRuleOf(item, rules?.fail ?? '')
    } else {
      rule = PENDING_RULE
    }
    if (item.id === 'sandbox-secrets') rule = `${rule} ${SANDBOX_FINDING}`
    line(`- ${item.id} (${item.adrs ?? '-'}): ${rule}`)
  }
  line()
  line('### 확정 근거 요약')
  line()
  line(`- 입력 전달 결정: ${adr5Conclusion(run)}`)
  line(`- resume 결정: ${adr10Conclusion(run)}`)
  line()
  line('개정은 요청으로만 기록한다.')
  line()

  line('## 알려진 한계')
  line()
  for (const limit of NOT_MEASURED_LIMITS) line(`- ${limit}`)
  line()

  return out.join('\n')
}
