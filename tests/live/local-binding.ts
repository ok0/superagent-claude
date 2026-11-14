/**
 * Pure helpers for the local binding live check and for prompt evidence in live playground runs; reads files only.
 */
import { basename } from 'node:path'
import { entries } from './review-evidence.ts'

export const SHADOW_CODE = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'

export function reachable(code: string | undefined): boolean {
  return code !== undefined && /^[23]\d\d$/.test(code)
}

export interface BindResult {
  bind?: string
  port?: number
  fetch?: string
  a?: string
  b?: string
}

export function parseBindOutput(text: string): BindResult {
  const result: BindResult = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    let match: RegExpExecArray | null
    if (result.bind === undefined && (match = /^BIND:ok:(\d+)/.exec(line))) {
      result.bind = 'ok'
      result.port = Number(match[1])
    } else if (result.bind === undefined && (match = /^BIND:(\S+)/.exec(line))) {
      result.bind = match[1]
    } else if (result.fetch === undefined && (match = /^FETCH:err:(\S+)/.exec(line))) {
      result.fetch = 'err:' + match[1]
    } else if (result.fetch === undefined && (match = /^FETCH:(\d+):/.exec(line))) {
      result.fetch = match[1]
    } else if (result.a === undefined && (match = /^A:(\d{3})/.exec(line))) {
      result.a = match[1]
    } else if (result.b === undefined && (match = /^B:(\d{3})/.exec(line))) {
      result.b = match[1]
    }
  }
  return result
}

export type BindVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'OBSERVED'

export function bindVerdict(o: {
  platform: NodeJS.Platform
  allowLocalBinding: boolean
  sandbox: boolean
  result: BindResult
}): { verdict: BindVerdict; reasons: string[] } {
  const { bind, fetch, b } = o.result
  if (!o.sandbox) return { verdict: 'BLOCKED', reasons: ['sandbox unavailable'] }
  if (o.platform !== 'darwin' && o.platform !== 'linux')
    return { verdict: 'BLOCKED', reasons: ['unsupported platform ' + o.platform] }
  if (bind === undefined) return { verdict: 'BLOCKED', reasons: ['bind command did not run'] }
  if (b === undefined) return { verdict: 'BLOCKED', reasons: ['outbound check did not run'] }
  if (reachable(b)) return { verdict: 'FAIL', reasons: ['non-allowed domain reachable: ' + b] }
  if (o.allowLocalBinding === true) {
    return bind === 'ok' && fetch === '200'
      ? { verdict: 'PASS', reasons: [] }
      : { verdict: 'FAIL', reasons: ['expected bind and fetch to succeed: bind=' + bind + ' fetch=' + fetch] }
  }
  if (o.platform === 'darwin') {
    return bind === 'EPERM'
      ? { verdict: 'PASS', reasons: [] }
      : { verdict: 'FAIL', reasons: ['expected EPERM: bind=' + bind] }
  }
  return { verdict: 'OBSERVED', reasons: ['bind=' + bind + ' fetch=' + (fetch ?? 'none')] }
}

export function shadowHits(texts: readonly string[]): number {
  return texts.reduce((total, text) => total + (text.split(SHADOW_CODE).length - 1), 0)
}

export interface ToolUseRecord {
  session: string
  sidechain: boolean
  name: string
  command?: string
  isError: boolean
  output: string
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: { type?: string }) => b.type === 'text')
    .map((b: { text?: string }) => b.text ?? '')
    .join('\n')
}

export function toolUses(files: readonly string[]): ToolUseRecord[] {
  const records: ToolUseRecord[] = []
  for (const file of files) {
    const session = basename(file, '.jsonl')
    const byId = new Map<string, ToolUseRecord>()
    for (const entry of entries(file)) {
      for (const block of entry.blocks) {
        if (block.type === 'tool_use') {
          const record: ToolUseRecord = {
            session,
            sidechain: entry.sidechain,
            name: block.name ?? '',
            isError: false,
            output: '',
          }
          if (typeof block.input?.command === 'string') record.command = block.input.command
          records.push(record)
          if (block.id !== undefined) byId.set(block.id, record)
        }
        if (block.type === 'tool_result' && block.tool_use_id !== undefined) {
          const record = byId.get(block.tool_use_id)
          if (!record) continue
          record.isError = block.is_error === true
          record.output = resultText(block.content).slice(-4000)
        }
      }
    }
  }
  return records
}

export function deniedAttempt(
  uses: readonly ToolUseRecord[],
  name: string,
  command?: RegExp,
): { attempted: boolean; denied: boolean } {
  const matching = uses.filter(u => u.name === name && (command === undefined || command.test(u.command ?? '')))
  const attempted = matching.length > 0
  return { attempted, denied: attempted && matching.every(u => u.isError) }
}

export function testRuns(uses: readonly ToolUseRecord[]): {
  session: string
  command: string
  isError: boolean
  serverTests: boolean
  failZero: boolean
  tail: string
}[] {
  return uses.flatMap(u => {
    if (u.name !== 'Bash' || u.sidechain || u.command === undefined) return []
    if (!/\bnpm( run)? test\b|\bnode --test\b/.test(u.command)) return []
    return [
      {
        session: u.session,
        command: u.command,
        isError: u.isError,
        serverTests: /^\s*(?:[✔✖]|(?:not )?ok \d+ -)\s+(?:GET|POST|PUT|PATCH|DELETE) \/\S*/m.test(u.output),
        failZero: /(#|ℹ) fail 0\b/.test(u.output),
        tail: u.output.slice(-1500),
      },
    ]
  })
}

export function unprefixedSettingKeys(text: string): string[] {
  return [
    ...text.matchAll(/(?<!security\.)\ballowLocalBinding\b/g),
    ...text.matchAll(/(?<!security\.)\bsandbox\.(?=[A-Za-z_])[A-Za-z_.]*/g),
  ].map(match => match[0])
}

const CHANGE_REQUEST =
  /\b(change|update|adjust|modify|edit|enable|disable|relax|loosen|turn (on|off))\b[^.\n]{0,60}\b(claude|cli|sandbox)\b[^.\n]{0,30}\b(settings?|config(uration)?|permissions?)\b/i
const SETTINGS_REFERENCE = /settings(\.local)?\.json|allowUnsandboxedCommands|dangerously|enableWeakerNestedSandbox/i

export function settingsChangeRequests(text: string): string[] {
  return text
    .replace(/issuecrew/g, '')
    .split('\n')
    .filter(line => CHANGE_REQUEST.test(line) || SETTINGS_REFERENCE.test(line))
}

export function imageRefs(text: string): string[] {
  return [
    ...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g),
    ...text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi),
  ].map(match => match[1] ?? '')
}

export function visualNote(text: string): { line: string | null; checks: boolean } {
  const lines = text.split('\n').map(line => line.trim())
  const index = lines.findIndex(
    line =>
      /visual evidence|screenshot|capture/i.test(line) &&
      /\bno\b|\bnot\b|\bwithout\b|n't|unavailable|cannot/i.test(line),
  )
  if (index === -1) return { line: null, checks: false }
  const line = lines[index] ?? ''
  const next = lines.slice(index + 1).find(l => l !== '') ?? ''
  const pattern = /\b(check|verify|confirm|look at|make sure|should see)\b/i
  return { line, checks: pattern.test(line) || pattern.test(next) }
}
