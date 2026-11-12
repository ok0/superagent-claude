/**
 * The canonical host tool names. Prompts, skills and tool registrations use these names;
 * the model sees them as `mcp__superagent__<name>`.
 */
export const ROUTER_TOOLS = [
  'orchestrator_read',
  'orchestrator_route',
  'orchestrator_ticket_retry',
  'orchestrator_ticket_request_status',
  'orchestrator_ticket_note',
  'orchestrator_trigger_requeue',
  'orchestrator_eval',
  'orchestrator_eval_read',
  'orchestrator_eval_decide',
  'orchestrator_reply',
  'orchestrator_thread_unsubscribe',
] as const
export const WORKER_TOOLS = [
  'orchestrator_read',
  'orchestrator_ack',
  'orchestrator_thread_unrelated',
  'orchestrator_thread_follow',
  'orchestrator_trigger_handback',
  'orchestrator_report',
  'orchestrator_publish',
  'orchestrator_review_reply',
  'orchestrator_pr_auto_merge',
  'orchestrator_pr_close',
  'git_inspect',
] as const
export type ToolName = (typeof ROUTER_TOOLS)[number] | (typeof WORKER_TOOLS)[number]
export const TOOL_NAMES: readonly ToolName[] = [...new Set([...ROUTER_TOOLS, ...WORKER_TOOLS])]
export const MCP_TOOL_PREFIX = 'mcp__superagent__'

export function toolNameViolations(text: string): string[] {
  const found: { index: number; value: string }[] = []
  for (const match of text.matchAll(/(?<!\w)orchestrator_[a-z_]+/g)) {
    found.push({ index: match.index ?? 0, value: `${match[0]} (missing ${MCP_TOOL_PREFIX})` })
  }
  for (const match of text.matchAll(/mcp__superagent__([a-z_]+)/g)) {
    const name = match[1] ?? ''
    if (!(TOOL_NAMES as readonly string[]).includes(name)) found.push({ index: match.index ?? 0, value: name })
  }
  for (const match of text.matchAll(/mcp__(?!superagent__)[a-z0-9_]+/g)) {
    found.push({ index: match.index ?? 0, value: match[0] })
  }
  return found.sort((a, b) => a.index - b.index).map(entry => entry.value)
}
