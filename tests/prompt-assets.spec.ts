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

  it('defines 11 router and 10 worker tools, 20 unique', () => {
    expect(ROUTER_TOOLS).toHaveLength(11)
    expect(WORKER_TOOLS).toHaveLength(10)
    expect(TOOL_NAMES).toHaveLength(20)
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length)
  })

  it('never instructs running gh or git push directly', () => {
    for (const asset of ASSETS) {
      for (const line of body(read(asset)).split('\n')) {
        if (!/\bgit push\b|(^|[\s`(])gh(\s|`|$)/.test(line)) continue
        expect(/\b(never|not|blocks?)\b/i.test(line), `${asset}: ${line}`).toBe(true)
      }
    }
    for (const asset of ASSETS) expect(body(read(asset)), asset).not.toContain('pr_number')
  })

  it('restores delivery and review-thread guidance on the host tools', () => {
    const delivery = body(read('prompts/team/delivery.md'))
    for (const token of ['mcp__superagent__orchestrator_publish', 'coAuthors', 'mcp__superagent__orchestrator_pr_auto_merge', 'mcp__superagent__orchestrator_pr_close']) {
      expect(delivery, token).toContain(token)
    }
    expect(body(read('prompts/team/communication.md'))).toContain('mcp__superagent__orchestrator_review_reply')
    const skill = body(read('skills/github.md'))
    for (const token of ['mcp__superagent__orchestrator_review_reply', 'mcp__superagent__orchestrator_publish', 'mcp__superagent__orchestrator_pr_close']) {
      expect(skill, token).toContain(token)
    }
  })

  it('guides the no-write-access branch with the publish and report tools and no fork', () => {
    const delivery = body(read('prompts/team/delivery.md'))
    for (const token of ['published: false', 'mcp__superagent__orchestrator_publish', 'mcp__superagent__orchestrator_report', 'state: blocked', 'write access']) {
      expect(delivery, token).toContain(token)
    }
    expect(body(read('skills/github.md'))).toContain('published: false')
    for (const asset of ASSETS) {
      const text = body(read(asset))
      expect(text, asset).not.toMatch(/fork/i)
      expect(toolNameViolations(text), asset).toEqual([])
    }
  })

  it('worker prompt points to the GitHub skill resource', () => {
    expect(body(read('prompts/worker.md'))).toContain('mcp__superagent__orchestrator_read skill/github')
  })
})
