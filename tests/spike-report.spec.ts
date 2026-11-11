import { describe, expect, it } from 'vitest'
import { checkText } from '../scripts/check-branding.ts'
import { renderReport } from '../spikes/sdk/lib/report.ts'
import type { ItemResult, RunRecord } from '../spikes/sdk/lib/types.ts'

const PREFIX = 'sk-' + 'ant-'
const IDS: [string, string][] = [
  ['steer', 'R9'],
  ['inputs-read', 'R10'],
  ['later-inject', 'R11'],
  ['interrupt', 'R12'],
  ['result', 'R13'],
  ['background-bash', 'R14'],
  ['resume', 'R15'],
  ['pretooluse-guard', 'R16'],
  ['disallowed-tools', 'R17'],
  ['setting-sources', 'R18'],
  ['sandbox-secrets', 'R19'],
]

function blocked(id: string, req: string): ItemResult {
  return {
    id,
    req,
    title: `${id} title`,
    status: 'BLOCKED',
    reason: 'no-credential',
    deviation: false,
    summary: 'no credential',
    observations: [],
    evidence: [],
    attempts: 0,
    costs: [],
    adrs: 'ADR-5',
  }
}

function fixture(overrides: Partial<RunRecord> = {}, steer?: Partial<ItemResult>): RunRecord {
  const version: ItemResult = {
    id: 'version',
    req: 'R20',
    title: 'version pin',
    status: 'PASS',
    deviation: false,
    summary: 'pinned',
    observations: [],
    evidence: [],
    attempts: 0,
    costs: [],
    adrs: '-',
  }
  const items: ItemResult[] = [version, ...IDS.map(([id, req]) => blocked(id, req))]
  if (steer !== undefined) {
    const index = items.findIndex(item => item.id === 'steer')
    items[index] = { ...items[index], ...steer } as ItemResult
  }
  return {
    startedAt: '2026-11-10T00:00:00.000Z',
    finishedAt: '2026-11-10T00:00:01.000Z',
    env: {
      sdkVersion: '0.3.321',
      cliVersion: '2.1.321',
      node: 'v22.20.0',
      os: 'Darwin 24.6.0 arm64',
      model: 'haiku',
      budgetCapUsd: 5,
    },
    auth: { mode: null },
    preflight: { live: false, problems: ['no credential: set ANTHROPIC_API_KEY'] },
    items,
    costModel: 'unknown',
    isolation: { checked: false, notes: [] },
    exitCode: 3,
    ...overrides,
  }
}

function tableRows(md: string): string[] {
  return md.split('\n').filter(line => line.startsWith('|'))
}

describe('renderReport', () => {
  it('renders every required section for a no-credential run', () => {
    const md = renderReport(fixture())
    for (const heading of [
      '## 실행 환경',
      '## 항목 요약',
      '## 항목별 상세',
      '## 비용',
      '## 격리 확인 (R3)',
      '## ADR 영향',
      '### 확정 근거 요약',
      '## 알려진 한계',
    ]) {
      expect(md).toContain(heading)
    }
    expect(md).toContain('없음(no-credential)')
  })

  it('lists each of the 11 items as a BLOCKED(no-credential) table row', () => {
    const md = renderReport(fixture())
    const blockedRows = tableRows(md).filter(line => line.includes('BLOCKED(no-credential)'))
    expect(blockedRows).toHaveLength(11)
    for (const [, req] of IDS) {
      expect(tableRows(md).some(line => line.includes(`| ${req} |`))).toBe(true)
    }
  })

  it('keeps ADR-5 and ADR-10 conclusions pending without measurements', () => {
    const md = renderReport(fixture())
    const adr5 = md.split('\n').find(line => line.includes('ADR-5:'))
    const adr10 = md.split('\n').find(line => line.includes('ADR-10:'))
    expect(adr5).toContain('보류')
    expect(adr10).toContain('보류')
  })

  it('passes the branding check and contains no credential prefix', () => {
    const md = renderReport(fixture())
    expect(checkText('.docs/spikes/sdk-semantics.md', md)).toEqual([])
    expect(md).not.toContain(PREFIX)
  })

  it('states the grey-area notice for subscription mode', () => {
    const md = renderReport(fixture({ auth: { mode: 'subscription' } }))
    expect(md).toContain('약관 회색지대')
  })

  it('prints the ADR number on each impact line', () => {
    const md = renderReport(fixture())
    expect(md).toContain('- steer (ADR-5): ')
    expect(md).toContain('- version (-): ')
  })

  it('marks a steer deviation as PASS(의미 차이) with the deviation conclusion', () => {
    const md = renderReport(fixture({}, { status: 'PASS', deviation: true, reason: undefined }))
    expect(tableRows(md).some(line => line.includes('PASS(의미 차이)'))).toBe(true)
    expect(md).toContain('같은 턴 미반영·다음 턴 반영')
    const adr5 = md.split('\n').find(line => line.includes('ADR-5:'))
    expect(adr5).toContain('대체안 채택(steer)')
  })
})
