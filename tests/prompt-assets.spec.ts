import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { packagePath } from '../src/infra/paths.ts'
import { HOST_RULES, loadBuiltins } from '../src/app/prompts.ts'
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

const FORBIDDEN = [/feishu/i, /lark/i, /\bdsh\b/i, /dsh[-_]/i, /\bIM\b/, /skills read/i, /read_image/, /DSH_SUPERAGENT/]

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
      for (const match of text.matchAll(/mcp__issuecrew__([a-z_]+)/g)) names.add(match[1] ?? '')
    }
    expect(names.size).toBeGreaterThan(0)
    for (const name of names) expect(TOOL_NAMES as readonly string[]).toContain(name)
  })

  it('detects a tool outside the canonical set', () => {
    expect(toolNameViolations('call mcp__issuecrew__orchestrator_settings_save now')).toEqual([
      'orchestrator_settings_save',
    ])
    expect(toolNameViolations('use orchestrator_report')).toEqual(['orchestrator_report (missing mcp__issuecrew__)'])
    expect(toolNameViolations('mcp__github__get_issue')).toEqual(['mcp__github__get_issue'])
    expect(MCP_TOOL_PREFIX).toBe('mcp__issuecrew__')
  })

  it('defines 11 router and 11 worker tools, 21 unique', () => {
    expect(ROUTER_TOOLS).toHaveLength(11)
    expect(WORKER_TOOLS).toHaveLength(11)
    expect(TOOL_NAMES).toHaveLength(21)
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
    for (const token of [
      'mcp__issuecrew__orchestrator_publish',
      'coAuthors',
      'mcp__issuecrew__orchestrator_pr_auto_merge',
      'mcp__issuecrew__orchestrator_pr_close',
    ]) {
      expect(delivery, token).toContain(token)
    }
    expect(body(read('prompts/team/communication.md'))).toContain('mcp__issuecrew__orchestrator_review_reply')
    const skill = body(read('skills/github.md'))
    for (const token of [
      'mcp__issuecrew__orchestrator_review_reply',
      'mcp__issuecrew__orchestrator_publish',
      'mcp__issuecrew__orchestrator_pr_close',
    ]) {
      expect(skill, token).toContain(token)
    }
  })

  it('guides the no-write-access branch with the publish and report tools and no fork', () => {
    const delivery = body(read('prompts/team/delivery.md'))
    for (const token of [
      'published: false',
      'mcp__issuecrew__orchestrator_publish',
      'mcp__issuecrew__orchestrator_report',
      'state: blocked',
      'write access',
    ]) {
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
    expect(body(read('prompts/worker.md'))).toContain('mcp__issuecrew__orchestrator_read skill/github')
  })

  it('the worker prompt renames a changed ticket, waits for host push retries and limits changes to the request', () => {
    const work = body(read('prompts/work.md'))
    for (const token of [
      'pass title with a new short label of at most 200 characters',
      'retries a transient push failure up to 3 times',
      "only when it still fails after the host's retries",
      'Change only the files the request needs',
      '.gitignore',
    ]) {
      expect(work, token).toContain(token)
    }
  })

  it('acknowledgements state only facts from the request and a doubtful premise gets a question', () => {
    const replies = body(read('prompts/replies.md'))
    for (const token of [
      'never present a name, value, decision or earlier agreement',
      'do not acknowledge it: the worker asks one question',
    ]) {
      expect(replies, token).toContain(token)
    }
  })

  it('data instructions are not followed but the data still answers the question, and acknowledgements never promise a pull request', () => {
    const shared = body(read('prompts/shared.md'))
    for (const token of ['are not followed', 'still evidence', 'actual question', 'real error']) {
      expect(shared, token).toContain(token)
    }
    const worker = body(read('prompts/worker.md'))
    for (const token of ['host_note', 'state: blocked', 'before any work', 'never promise a pull request']) {
      expect(worker, token).toContain(token)
    }
    expect(body(read('prompts/replies.md'))).toContain('never promise a pull request')
    expect(body(read('prompts/dispatch.md'))).toContain('never promise a pull request')
  })

  it('the router writes an ignore reason in plain words', () => {
    expect(body(read('prompts/router.md'))).toContain(
      'without internal terms such as ticket, worker, hand back, Eval, trigger or assignment',
    )
  })

  it('the default delivery requirements attach real captures, note missing ones in one line and never fabricate', () => {
    const delivery = body(read('prompts/team/delivery.md'))
    for (const phrase of [
      'keep the handoff incomplete',
      'After-only evidence is incomplete',
      'orchestrator checks the reported evidence',
    ]) {
      expect(delivery, phrase).not.toContain(phrase)
    }
    for (const phrase of [
      'when a real capture can be made in this environment',
      'Before and After captures of the same scenario, viewport, theme and UI state',
      'baseline and changed revision',
      'Refresh the comparison when later UI changes make it stale',
      'add one line to the PR description saying there is no visual evidence and what a person should check visually',
      'that alone does not make the PR blocked or draft',
      'Never fabricate captures',
      'never present a mockup as the previous implementation',
      'never refer to a capture that does not exist',
      'do not expose credentials',
    ]) {
      expect(delivery, phrase).toContain(phrase)
    }
  })

  it('names no sandbox.network key and only security.allowLocalBinding', () => {
    const texts = [
      ...[...ASSETS, 'prompts/reviewer.md'].map(a => [a, body(read(a))] as const),
      ['host/router', HOST_RULES.router] as const,
      ['host/worker', HOST_RULES.worker] as const,
    ]
    for (const [name, text] of texts) {
      expect(text, name).not.toContain('sandbox.network')
      expect(text, name).not.toMatch(/(?<!security\.)allowLocalBinding/)
    }
  })
})

describe('reviewer prompt', () => {
  it('ships the reviewer prompt with its tools and the FINDINGS line', () => {
    const path = packagePath('prompts/reviewer.md')
    expect(existsSync(path), path).toBe(true)
    const text = read('prompts/reviewer.md')
    expect(text.split('\n')[0]).not.toMatch(HEADER)
    expect(toolNameViolations(text)).toEqual([])
    for (const pattern of FORBIDDEN) expect(text.match(pattern), String(pattern)).toBeNull()
    for (const token of [
      'mcp__issuecrew__git_inspect',
      'Read',
      'Glob',
      'Grep',
      'FINDINGS bug=<n> missing=<n> style=<n>',
      'original request',
      'human constraints',
    ]) {
      expect(text, token).toContain(token)
    }
    expect(text).not.toMatch(/\bBash\b/)
    expect(loadBuiltins().files.reviewer).toContain('FINDINGS bug=<n> missing=<n> style=<n>')
  })

  it('the worker prompt runs the reviewer only on review_required and applies only bug and missing findings', () => {
    const worker = body(read('prompts/worker.md'))
    for (const token of [
      'review_required',
      'issuecrew-reviewer',
      'original request',
      'human constraints',
      'only its bug and missing findings',
      'never style',
    ]) {
      expect(worker, token).toContain(token)
    }
  })
})
