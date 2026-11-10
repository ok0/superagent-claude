import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk'
import type { ItemResult, SpikeContext, SpikeItem } from '../lib/types.ts'
import { isMain } from '../lib/types.ts'
import { baseOptions, compact, field, runScenario } from '../lib/session.ts'

const META = { id: 'setting-sources', req: 'R18', title: 'settingSources 격리 (저장소 hook·.mcp.json)' }

interface CaseSpec {
  name: string;
  sources: SettingSource[];
}

interface Markers {
  sessionstart: boolean;
  prompt: boolean;
  mcp: boolean;
}

const CASES: CaseSpec[] = [
  { name: 'empty', sources: [] },
  { name: 'project', sources: ['project'] },
]

const NONE: Markers = { sessionstart: false, prompt: false, mcp: false }

async function run(ctx: SpikeContext): Promise<ItemResult> {
  const observations: string[] = []
  const evidence: string[] = []
  const costs: number[][] = []
  const found = new Map<string, Markers>()

  mkdirSync(ctx.markerDir, { recursive: true })
  for (const spec of CASES) {
    const repo = ctx.newRepo(`settings-${spec.name}`)
    const sessionStart = join(ctx.markerDir, `${spec.name}-sessionstart.marker`)
    const prompt = join(ctx.markerDir, `${spec.name}-prompt.marker`)
    const mcp = join(ctx.markerDir, `${spec.name}-mcp.marker`)

    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify(
        {
          enableAllProjectMcpServers: true,
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: `touch ${sessionStart}` }] }],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${prompt}` }] }],
          },
        },
        null,
        2,
      ),
    )
    writeFileSync(
      join(repo, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            spike: {
              command: 'node',
              args: ['-e', `require('node:fs').writeFileSync('${mcp}','1')`],
            },
          },
        },
        null,
        2,
      ),
    )

    const outcome = await runScenario({
      ctx,
      options: baseOptions(ctx, repo, { settingSources: spec.sources }),
      first: { text: 'Reply with exactly OK' },
      onEntry: (e, c) => {
        if (e.type === 'result') c.end()
      },
    })
    costs.push(outcome.costs)
    evidence.push(...outcome.timeline.map(compact))
    if (outcome.init !== undefined && spec.name === 'empty') {
      observations.push(
        `apiKeySource=${String(field(outcome.init, 'apiKeySource'))}`,
        `cliVersion=${String(field(outcome.init, 'claude_code_version'))}`,
      )
    }

    const markers: Markers = {
      sessionstart: existsSync(sessionStart),
      prompt: existsSync(prompt),
      mcp: existsSync(mcp),
    }
    found.set(spec.name, markers)
    const created = Object.entries(markers)
      .filter(([, v]) => v)
      .map(([k]) => k)
    observations.push(`${spec.name}: markers=${created.length === 0 ? 'none' : created.join(',')}`)
  }

  const empty = found.get('empty') ?? NONE
  const project = found.get('project') ?? NONE
  const emptyAny = empty.sessionstart || empty.prompt || empty.mcp
  const projectHook = project.sessionstart || project.prompt
  const projectAny = projectHook || project.mcp

  if (emptyAny) {
    return {
      ...META,
      status: 'FAIL',
      deviation: false,
      summary: 'settingSources:[] 케이스에서 저장소 설정·MCP 실행됨',
      observations,
      evidence,
      attempts: 1,
      costs,
    }
  }
  if (!projectAny) {
    return {
      ...META,
      status: 'FAIL',
      deviation: false,
      summary: 'control invalid: project 케이스에서 저장소 설정 미실행',
      observations,
      evidence,
      attempts: 1,
      costs,
    }
  }
  if (projectHook && project.mcp) {
    return {
      ...META,
      status: 'PASS',
      deviation: false,
      summary: 'empty 0건, project 케이스에서 hook·MCP 실행 확인',
      observations,
      evidence,
      attempts: 1,
      costs,
    }
  }
  if (projectHook) {
    observations.push('mcp control not triggered')
    return {
      ...META,
      status: 'PASS',
      deviation: true,
      summary: 'empty 0건, project hook 실행 확인 (mcp 경로 미확인)',
      observations,
      evidence,
      attempts: 1,
      costs,
    }
  }
  observations.push('hook path not triggered; mcp only')
  return {
    ...META,
    status: 'PASS',
    deviation: true,
    summary: 'empty 0건, project MCP만 실행 (hook 경로 미확인)',
    observations,
    evidence,
    attempts: 1,
    costs,
  }
}

export const item: SpikeItem = { ...META, adrs: 'ADR-7', live: true, estimateUsd: 0.1, run }

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
