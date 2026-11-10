import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { packagePath } from '../src/infra/paths.ts'
import { MCP_TOOL_PREFIX, ROUTER_TOOLS, TOOL_NAMES, WORKER_TOOLS, toolNameViolations } from '../src/app/tool-names.ts'

const ASSETS = [
  'prompts/shared.md',
  'prompts/router.md',
  'prompts/worker.md',
  'prompts/subscriptions.md',
  'prompts/replies.md',
  'prompts/dispatch.md',
  'prompts/work.md',
  'prompts/admission.md',
  'prompts/handoff.md',
  'prompts/handoff-router.md',
  'prompts/handoff-worker.md',
  'prompts/team/communication.md',
  'prompts/team/scope.md',
  'prompts/team/delivery.md',
  'skills/github.md',
]

const HEADER = /^<!-- Ported from dsh-superagent-prototype \(MIT\) \S+ -->$/

const FORBIDDEN = [
  /feishu/i,
  /lark/i,
  /\bdsh\b/i,
  /dsh[-_]/i,
  /\bIM\b/,
  /skills read/i,
  /read_image/,
  /DSH_SUPERAGENT/,
]

function body(text: string): string {
  return text.split('\n').slice(1).join('\n')
}

function read(asset: string): string {
  return readFileSync(packagePath(asset), 'utf8')
}

describe('ported prompt and skill assets', () => {
  it('ships every ported prompt and skill with a source header', () => {
    for (const asset of ASSETS) {
      const path = packagePath(asset)
      expect(existsSync(path), path).toBe(true)
      const text = read(asset)
      const firstLine = text.split('\n')[0]
      expect(firstLine, asset).toMatch(HEADER)
      expect(body(text).trim().length, asset).toBeGreaterThan(0)
    }
  })

  it('contains no Feishu, lark or DSH terms', () => {
    for (const asset of ASSETS) {
      const text = body(read(asset))
      for (const pattern of FORBIDDEN) {
        const match = text.match(pattern)
        expect(match === null, `${asset} matches ${pattern}: ${match?.[0] ?? ''}`).toBe(true)
      }
    }
  })

  it('names only canonical host tools, with the MCP prefix', () => {
    const names = new Set<string>()
    for (const asset of ASSETS) {
      const text = body(read(asset))
      expect(toolNameViolations(text), asset).toEqual([])
      for (const match of text.matchAll(/mcp__superagent__([a-z_]+)/g)) names.add(match[1] ?? '')
    }
    expect(names.size).toBeGreaterThan(0)
    for (const name of names) expect(TOOL_NAMES as readonly string[]).toContain(name)
  })

  it('detects a tool outside the canonical set', () => {
    expect(toolNameViolations('call mcp__superagent__orchestrator_settings_save now')).toEqual(['orchestrator_settings_save'])
    expect(toolNameViolations('use orchestrator_report')).toEqual(['orchestrator_report (missing mcp__superagent__)'])
    expect(toolNameViolations('mcp__github__get_issue')).toEqual(['mcp__github__get_issue'])
    expect(MCP_TOOL_PREFIX).toBe('mcp__superagent__')
  })

  it('defines 11 router and 7 worker tools, 17 unique', () => {
    expect(ROUTER_TOOLS).toHaveLength(11)
    expect(WORKER_TOOLS).toHaveLength(7)
    expect(TOOL_NAMES).toHaveLength(17)
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length)
  })

  it('worker prompt points to the GitHub skill resource', () => {
    expect(body(read('prompts/worker.md'))).toContain('mcp__superagent__orchestrator_read skill/github')
  })
})
