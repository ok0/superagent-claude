/** The AgentRuntime port. Semantics are in docs/runtime-contract.md. */
import type { z } from 'zod'
/**
 * steer: read at the next tool-call boundary of the running turn; followup: starts a new turn after the current one;
 * inject: wakes nothing and is merged into the next input sent. A runtime that cannot steer treats steer as followup.
 */
export type InputMode = 'steer' | 'followup' | 'inject'
export type TurnOutcome = 'success' | 'max_turns' | 'budget' | 'error'
export interface RuntimeInput {
  id: string
  text: string
  mode: InputMode
}
export interface ToolSpec {
  name: string
  description: string
  schema: z.ZodObject
  execute(args: unknown, signal: AbortSignal): Promise<unknown>
}
/** A named subagent the worker may start. Runtime-neutral: the adapter maps it to its own agent definitions. */
export interface SubagentSpec {
  name: string
  description: string
  instructions: string
  /** Built-in tools: 'read' means file read and search only. */
  tools: 'read'
  /** Host tool names, without the MCP prefix, that this subagent may call. */
  hostTools: readonly string[]
  /** Decided right before the subagent starts. undefined refuses the call. */
  admit(): Promise<{ preamble: string } | undefined>
  /** The subagent's final text output once it returns. */
  finished?(output: string): void
}
export interface SessionSpec {
  key: string
  role: 'router' | 'worker'
  cwd: string
  instructions: string
  tools: ToolSpec[]
  builtins: { fs: 'none' | 'read' | 'write'; shell: boolean; web: false }
  network: { allow: string[] }
  limits: { maxTurns: number; maxBudgetUsd: number }
  resume?: string
  model?: string
  env: Record<string, string>
  subagents?: SubagentSpec[]
}
/** What a session reports back to the host, in order. */
export type RuntimeEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'inputsRead'; ids: string[] }
  | { type: 'turnEnded'; outcome: TurnOutcome; turns: number; costUsd: number; background: number; discarded?: true }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'closed' }
export interface RuntimeProbe {
  sandbox: boolean
  version: string
}
export interface AgentSession {
  readonly sessionId?: string
  send(input: RuntimeInput): void
  events(): AsyncIterable<RuntimeEvent>
  /**
   * Stops the running turn (no turnEnded follows for it). stillQueued holds the ids of inputs not yet read,
   * including pending followup and inject inputs the adapter has not handed to the runtime.
   */
  interrupt(): Promise<{ stillQueued: string[] }>
  close(): Promise<void>
}
export interface AgentRuntime {
  readonly id: string
  open(spec: SessionSpec): Promise<AgentSession>
  probe(): Promise<RuntimeProbe>
  /**
   * Stops what an earlier host process on the same state left running, before recovery starts.
   * Returns the pids it stopped.
   */
  reap?(): Promise<number[]>
}
/**
 * Idempotent: `fresh` returns, in order, the ids it has not returned before.
 * Duplicates within one call count once.
 */
export class ReadLedger {
  private readonly seen = new Set<string>()
  fresh(ids: readonly string[]): string[] {
    const out: string[] = []
    for (const id of ids)
      if (!this.seen.has(id)) {
        this.seen.add(id)
        out.push(id)
      }
    return out
  }
}
