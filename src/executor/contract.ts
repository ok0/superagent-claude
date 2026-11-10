/** The AgentRuntime port: what the WorkerExecutor and the Router host need from an agent runtime. Semantics are in docs/runtime-contract.md. */
import type { z } from 'zod'
/** steer: read at the next tool-call boundary of the running turn; followup: starts a new turn after the current one; inject: wakes nothing and is merged into the next input sent. A runtime that cannot steer treats steer as followup. */
export type InputMode = 'steer' | 'followup' | 'inject'
/** How a turn ended: normally, at the turn limit, at the budget limit, or with an error. */
export type TurnOutcome = 'success' | 'max_turns' | 'budget' | 'error'
/** One input given to a session: its id, text and delivery mode. */
export interface RuntimeInput { id: string; text: string; mode: InputMode }
/** A host tool a session may call, with its argument schema and its execution. */
export interface ToolSpec { name: string; description: string; schema: z.ZodObject; execute(args: unknown, signal: AbortSignal): Promise<unknown> }
/** Everything a runtime needs to open a session. */
export interface SessionSpec {
  key: string; role: 'router' | 'worker'; cwd: string; instructions: string; tools: ToolSpec[]
  builtins: { fs: 'none' | 'read' | 'write'; shell: boolean; web: false }
  network: { allow: string[] }; limits: { maxTurns: number; maxBudgetUsd: number }
  resume?: string; model?: string; env: Record<string, string>
}
/** What a session reports back to the host, in order. */
export type RuntimeEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'inputsRead'; ids: string[] }
  | { type: 'turnEnded'; outcome: TurnOutcome; turns: number; costUsd: number; background: number; discarded?: true }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'closed' }
/** What a runtime reports about its sandbox and version. */
export interface RuntimeProbe { sandbox: boolean; version: string }
/** One open conversation with a runtime. */
export interface AgentSession {
  readonly sessionId?: string
  send(input: RuntimeInput): void
  events(): AsyncIterable<RuntimeEvent>
  /** Stops the running turn (no turnEnded follows for it); stillQueued holds the ids of inputs not yet read, including pending followup and inject inputs the adapter has not handed to the runtime. */
  interrupt(): Promise<{ stillQueued: string[] }>
  close(): Promise<void>
}
/** A runtime adapter: opens sessions and reports its probe. */
export interface AgentRuntime { readonly id: string; open(spec: SessionSpec): Promise<AgentSession>; probe(): Promise<RuntimeProbe> }
/** Applies inputsRead idempotently: `fresh` returns, in order, the ids it has not returned before (duplicates within one call count once). */
export class ReadLedger {
  private readonly seen = new Set<string>()
  fresh(ids: readonly string[]): string[] { const out: string[] = []; for (const id of ids) if (!this.seen.has(id)) { this.seen.add(id); out.push(id) } return out }
}
