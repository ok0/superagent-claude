/** Transcript and log evidence for the pre-publish reviewer live checks: tool use, reviewer briefs, token usage and finding references. Reads files only. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const FORBIDDEN = ['Bash', 'Write', 'Edit', 'NotebookEdit'] as const
export const BRIEF_MARKER = 'Host review brief'

export interface Block {
  type?: string
  name?: string
  id?: string
  tool_use_id?: string
  is_error?: boolean
  text?: string
  input?: Record<string, unknown>
  content?: unknown
}

export interface Entry {
  file: string
  sidechain: boolean
  role?: string
  messageId?: string
  usage?: Record<string, unknown>
  blocks: Block[]
  text: string
}

export function walk(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap(name => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

export function transcriptFiles(root: string): string[] {
  return walk(root).filter(f => f.endsWith('.jsonl'))
}

export function entries(file: string): Entry[] {
  const result: Entry[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const message = (typeof raw.message === 'object' && raw.message !== null ? raw.message : {}) as Record<
      string,
      unknown
    >
    const content = message.content
    const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : []
    const text =
      typeof content === 'string'
        ? content
        : blocks
            .filter(b => b.type === 'text')
            .map(b => b.text ?? '')
            .join('\n')
    const usage =
      typeof message.usage === 'object' && message.usage !== null
        ? (message.usage as Record<string, unknown>)
        : undefined
    result.push({
      file,
      sidechain: file.includes('/subagents/') || raw.isSidechain === true,
      role: typeof message.role === 'string' ? message.role : undefined,
      messageId: typeof message.id === 'string' ? message.id : undefined,
      usage,
      blocks,
      text,
    })
  }
  return result
}

export interface Sidechain {
  file: string
  prompt: string
  output: string
  toolUses: { name: string; id?: string; input?: Record<string, unknown> }[]
  errors: Set<string>
}

export function sidechains(files: readonly string[]): Sidechain[] {
  const result: Sidechain[] = []
  for (const file of files) {
    const es = entries(file)
    if (es.length === 0 || !es.every(e => e.sidechain)) continue
    const prompt = es.find(e => e.role === 'user')?.text ?? ''
    const output = [...es].reverse().find(e => e.role === 'assistant' && e.text !== '')?.text ?? ''
    const toolUses: Sidechain['toolUses'] = []
    const errors = new Set<string>()
    for (const e of es) {
      for (const block of e.blocks) {
        if (block.type === 'tool_use') toolUses.push({ name: block.name ?? '', id: block.id, input: block.input })
        if (block.type === 'tool_result' && block.is_error === true && block.tool_use_id !== undefined)
          errors.add(block.tool_use_id)
      }
    }
    result.push({ file, prompt, output, toolUses, errors })
  }
  return result
}

export function reviewerSidechains(files: readonly string[]): Sidechain[] {
  return sidechains(files).filter(s => s.prompt.includes(BRIEF_MARKER))
}

export interface BriefMarkers {
  originalRequest: boolean
  requestText: boolean
  hostDiff: boolean
  diffBody: boolean
}

export function briefMarkers(prompt: string, requestSnippet: string): BriefMarkers {
  return {
    originalRequest:
      prompt.includes('## Original request') && prompt.includes('<external-data source="original-request">'),
    requestText: requestSnippet !== '' && prompt.includes(requestSnippet),
    hostDiff: prompt.includes('## Host diff ') && prompt.includes('<external-data source="host-diff">'),
    diffBody: prompt.includes('diff --git '),
  }
}

export interface Usage {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
  total: number
}

const num = (value: unknown): number => (typeof value === 'number' ? value : 0)

export function tokenUsage(files: readonly string[]): Usage {
  const byId = new Map<string, Record<string, unknown>>()
  const anonymous: Record<string, unknown>[] = []
  for (const file of files)
    for (const e of entries(file)) {
      if (e.role !== 'assistant' || !e.usage) continue
      if (e.messageId === undefined) anonymous.push(e.usage)
      else byId.set(e.messageId, e.usage)
    }
  const all = [...byId.values(), ...anonymous]
  const input = all.reduce((sum, u) => sum + num(u.input_tokens), 0)
  const output = all.reduce((sum, u) => sum + num(u.output_tokens), 0)
  const cacheCreation = all.reduce((sum, u) => sum + num(u.cache_creation_input_tokens), 0)
  const cacheRead = all.reduce((sum, u) => sum + num(u.cache_read_input_tokens), 0)
  return { input, output, cacheCreation, cacheRead, total: input + output + cacheCreation + cacheRead }
}

export interface FindingRef {
  kind: 'bug' | 'missing' | 'style'
  path: string
  line: number
}

const FINDING = /\b(bug|missing|style)\b[^\n]*?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)/i

export function findingRefs(output: string): FindingRef[] {
  const refs: FindingRef[] = []
  for (const line of output.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('FINDINGS ')) continue
    const match = FINDING.exec(line)
    if (!match) continue
    refs.push({
      kind: (match[1] ?? '').toLowerCase() as FindingRef['kind'],
      path: match[2] ?? '',
      line: Number(match[3]),
    })
  }
  return refs
}

export function appliedCount(refs: readonly FindingRef[], changedFiles: readonly string[]): number {
  const keys = new Set<string>()
  for (const ref of refs) {
    if (ref.kind !== 'bug' && ref.kind !== 'missing') continue
    if (!changedFiles.some(f => f === ref.path || f.endsWith('/' + ref.path))) continue
    keys.add(ref.path + ':' + ref.line)
  }
  return keys.size
}

export interface HookRecord {
  phase: 'pre' | 'post'
  tool: string
  agentId?: string
  agentType?: string
}

export type ToolOutcome =
  'attempted-and-denied' | 'attempted-blocked-by-sdk' | 'not-attempted' | 'attempted-and-allowed'

export function forbiddenSummary(o: {
  hooks: readonly HookRecord[]
  denials: readonly { tool: string; agentId?: string }[]
  reviewer: readonly Sidechain[]
}): {
  attempted: Record<string, number>
  permitted: Record<string, number>
  executed: Record<string, number>
  denied: Record<string, number>
} {
  const attempted: Record<string, number> = {}
  const permitted: Record<string, number> = {}
  const executed: Record<string, number> = {}
  const denied: Record<string, number> = {}
  for (const tool of FORBIDDEN) {
    attempted[tool] = o.reviewer.flatMap(s => s.toolUses).filter(u => u.name === tool).length
    denied[tool] = o.denials.filter(d => d.tool === tool && d.agentId !== undefined).length
    const pre = o.hooks.filter(h => h.phase === 'pre' && h.tool === tool && h.agentId !== undefined).length
    permitted[tool] = Math.max(0, pre - (denied[tool] ?? 0))
    executed[tool] = o.hooks.filter(h => h.phase === 'post' && h.tool === tool && h.agentId !== undefined).length
  }
  return { attempted, permitted, executed, denied }
}

export function toolOutcome(tool: string, s: ReturnType<typeof forbiddenSummary>): ToolOutcome {
  if ((s.permitted[tool] ?? 0) > 0 || (s.executed[tool] ?? 0) > 0) return 'attempted-and-allowed'
  if ((s.denied[tool] ?? 0) > 0) return 'attempted-and-denied'
  if ((s.attempted[tool] ?? 0) > 0) return 'attempted-blocked-by-sdk'
  return 'not-attempted'
}
