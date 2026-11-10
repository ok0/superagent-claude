import { randomUUID, type UUID } from 'node:crypto'
import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { SpikeContext } from './types.ts'

export interface UserInput { text: string; uuid?: string; priority?: 'next' | 'later'; shouldQuery?: boolean }

export interface TimelineEntry {
  t: number; type: string; subtype?: string; keys: string[];
  uuid?: string; userMessageUuid?: string; text?: string;
  toolUses?: { id: string; name: string; input: string }[];
  toolResults?: { toolUseId: string; content: string; isError: boolean }[];
  result?: { subtype: string; totalCostUsd?: number; numTurns?: number; sessionId?: string; origin?: unknown; terminalReason?: unknown; resultText?: string };
}

export interface ScenarioControl {
  push(input: UserInput): string;
  interrupt(): Promise<unknown>;
  end(): void;
  after(ms: number, fn: (c: ScenarioControl) => void | Promise<void>): void;
  elapsed(): number; timeline: TimelineEntry[]; results: TimelineEntry[];
}

export interface ScenarioOutcome {
  timeline: TimelineEntry[]; results: TimelineEntry[]; sessionId?: string; costs: number[];
  timedOut: boolean; error?: string; init?: Record<string, unknown>; stderr: string;
}

const STDERR_CAP = 4000
const TEXT_CAP = 200
const RESULT_CAP = 300
const DRAIN_MS = 10000

const stderrSinks = new WeakMap<Options, { text: string }>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) + '...' : text
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class InputQueue implements AsyncIterable<SDKUserMessage> {
  buf: SDKUserMessage[] = [];
  waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  done = false;

  push(m: SDKUserMessage): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: m, done: false });
      return;
    }
    this.buf.push(m);
  }

  end(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const buffered = this.buf.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

export function field(msg: unknown, key: string): unknown {
  return isRecord(msg) ? msg[key] : undefined;
}

function toUserMessage(input: UserInput, uuid: string): SDKUserMessage {
  const message: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: input.text },
    parent_tool_use_id: null,
    session_id: '',
    uuid: uuid as UUID,
  };
  if (input.priority !== undefined) message.priority = input.priority;
  if (input.shouldQuery !== undefined) message.shouldQuery = input.shouldQuery;
  return message;
}

export function baseOptions(ctx: SpikeContext, cwd: string, extra?: Partial<Options>): Options {
  const sink = { text: '' };
  const base: Options = {
    cwd,
    env: ctx.sdkEnv(),
    settingSources: [],
    model: ctx.model,
    maxTurns: 8,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    disallowedTools: ['AskUserQuestion', 'WebFetch', 'WebSearch'],
    abortController: new AbortController(),
    stderr: (d: string) => {
      if (sink.text.length < STDERR_CAP) sink.text = (sink.text + d).slice(0, STDERR_CAP);
    },
  };
  if (ctx.supports.maxBudgetUsd) base.maxBudgetUsd = Math.min(1, ctx.remainingUsd());
  const merged: Options = { ...base, ...extra };
  stderrSinks.set(merged, sink);
  return merged;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        const text = field(block, 'text');
        return typeof text === 'string' ? text : (JSON.stringify(block) ?? '');
      })
      .join('\n');
  }
  return JSON.stringify(content) ?? '';
}

export function toEntry(msg: unknown, t: number): TimelineEntry {
  const type = String(field(msg, 'type') ?? 'unknown');
  const entry: TimelineEntry = { t, type, keys: isRecord(msg) ? Object.keys(msg) : [] };
  const subtype = field(msg, 'subtype');
  if (typeof subtype === 'string') entry.subtype = subtype;
  const uuid = field(msg, 'uuid');
  if (typeof uuid === 'string') entry.uuid = uuid;
  const userMessageUuid = field(msg, 'user_message_uuid');
  if (typeof userMessageUuid === 'string') entry.userMessageUuid = userMessageUuid;

  const content = field(field(msg, 'message'), 'content');
  if (typeof content === 'string') {
    entry.text = clip(content, TEXT_CAP);
  } else if (Array.isArray(content)) {
    const texts: string[] = [];
    const toolUses: { id: string; name: string; input: string }[] = [];
    const toolResults: { toolUseId: string; content: string; isError: boolean }[] = [];
    for (const block of content) {
      const blockType = field(block, 'type');
      if (blockType === 'text') {
        const text = field(block, 'text');
        if (typeof text === 'string') texts.push(text);
      } else if (blockType === 'tool_use') {
        const id = field(block, 'id');
        const name = field(block, 'name');
        toolUses.push({
          id: typeof id === 'string' ? id : '',
          name: typeof name === 'string' ? name : '',
          input: clip(JSON.stringify(field(block, 'input') ?? null) ?? '', TEXT_CAP),
        });
      } else if (blockType === 'tool_result') {
        const toolUseId = field(block, 'tool_use_id');
        toolResults.push({
          toolUseId: typeof toolUseId === 'string' ? toolUseId : '',
          content: clip(blockText(field(block, 'content')), RESULT_CAP),
          isError: field(block, 'is_error') === true,
        });
      }
    }
    if (texts.length > 0) entry.text = clip(texts.join('\n'), TEXT_CAP);
    if (toolUses.length > 0) entry.toolUses = toolUses;
    if (toolResults.length > 0) entry.toolResults = toolResults;
  }

  if (type === 'result') {
    const result: NonNullable<TimelineEntry['result']> = {
      subtype: subtype === undefined ? '' : String(subtype),
    };
    const cost = field(msg, 'total_cost_usd');
    if (typeof cost === 'number') result.totalCostUsd = cost;
    const turns = field(msg, 'num_turns');
    if (typeof turns === 'number') result.numTurns = turns;
    const sessionId = field(msg, 'session_id');
    if (typeof sessionId === 'string') result.sessionId = sessionId;
    const origin = field(msg, 'origin');
    if (origin !== undefined) result.origin = origin;
    const terminalReason = field(msg, 'terminal_reason');
    if (terminalReason !== undefined) result.terminalReason = terminalReason;
    const resultText = field(msg, 'result');
    if (typeof resultText === 'string') result.resultText = resultText;
    entry.result = result;
  }
  return entry;
}

export interface RunScenarioArgs {
  ctx: SpikeContext;
  options: Options;
  first: UserInput;
  onEntry?: (e: TimelineEntry, c: ScenarioControl) => void | Promise<void>;
  timeoutMs?: number;
}

export async function runScenario(args: RunScenarioArgs): Promise<ScenarioOutcome> {
  const { options, first, onEntry, timeoutMs = 180000 } = args;
  const queue = new InputQueue();
  const timeline: TimelineEntry[] = [];
  const results: TimelineEntry[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const started = Date.now();
  let timedOut = false;
  let stopped = false;
  let error: string | undefined;
  let sessionId: string | undefined;
  let init: Record<string, unknown> | undefined;
  let pending: Promise<IteratorResult<SDKMessage, void>> | undefined;

  let resolveStop: (value: 'stop') => void = () => undefined;
  const stopSignal = new Promise<'stop'>((resolve) => {
    resolveStop = resolve;
  });
  const timeoutSignal = new Promise<'timeout'>((resolve) => {
    timers.push(
      setTimeout(() => {
        timedOut = true;
        resolve('timeout');
      }, timeoutMs),
    );
  });

  const record = (entry: TimelineEntry): void => {
    timeline.push(entry);
    if (entry.type === 'result') results.push(entry);
  };

  const absorb = (msg: unknown, entry: TimelineEntry): void => {
    const sid = field(msg, 'session_id');
    if (typeof sid === 'string' && sid !== '') sessionId = sid;
    if (entry.type === 'system' && entry.subtype === 'init' && init === undefined && isRecord(msg)) {
      init = msg;
    }
    record(entry);
  };

  queue.push(toUserMessage(first, first.uuid ?? randomUUID()));
  const q: Query = query({ prompt: queue, options });

  const nextMessage = (): Promise<IteratorResult<SDKMessage, void>> => {
    if (pending === undefined) pending = q.next();
    return pending;
  };

  const control: ScenarioControl = {
    push(input: UserInput): string {
      const uuid = input.uuid ?? randomUUID();
      queue.push(toUserMessage(input, uuid));
      return uuid;
    },
    async interrupt(): Promise<unknown> {
      const receipt = await q.interrupt();
      return receipt === undefined ? null : (JSON.parse(JSON.stringify(receipt)) as unknown);
    },
    end(): void {
      stopped = true;
      queue.end();
      resolveStop('stop');
    },
    after(ms: number, fn: (c: ScenarioControl) => void | Promise<void>): void {
      timers.push(
        setTimeout(() => {
          Promise.resolve()
            .then(() => fn(control))
            .catch((e: unknown) => {
              if (error === undefined) error = errorMessage(e);
            });
        }, ms),
      );
    },
    elapsed(): number {
      return Date.now() - started;
    },
    timeline,
    results,
  };

  try {
    while (!stopped && !timedOut) {
      const step = await Promise.race([
        nextMessage().then((r) => ({ kind: 'msg' as const, r })),
        stopSignal.then(() => ({ kind: 'stop' as const })),
        timeoutSignal.then(() => ({ kind: 'timeout' as const })),
      ]);
      if (step.kind !== 'msg') break;
      pending = undefined;
      const r = step.r;
      if (r.done === true) break;
      const msg: unknown = r.value;
      const entry = toEntry(msg, control.elapsed());
      absorb(msg, entry);
      if (onEntry !== undefined) await onEntry(entry, control);
    }
  } catch (e) {
    error = errorMessage(e);
  }

  if (timedOut) options.abortController?.abort();
  queue.end();
  if (typeof q.close === 'function') q.close();
  for (const timer of timers) clearTimeout(timer);
  timers.length = 0;

  const drainDeadline = new Promise<'deadline'>((resolve) => {
    timers.push(setTimeout(() => resolve('deadline'), DRAIN_MS));
  });
  try {
    while (true) {
      const step = await Promise.race([nextMessage(), drainDeadline]);
      if (step === 'deadline') break;
      pending = undefined;
      if (step.done === true) break;
      const msg: unknown = step.value;
      absorb(msg, toEntry(msg, control.elapsed()));
    }
  } catch {
    pending = undefined;
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
  }

  return {
    timeline,
    results,
    sessionId,
    costs: results.map((r) => r.result?.totalCostUsd ?? 0),
    timedOut,
    error,
    init,
    stderr: stderrSinks.get(options)?.text ?? '',
  };
}

export function textOf(entries: TimelineEntry[]): string {
  return entries
    .flatMap((e) => [e.type === 'assistant' ? e.text : undefined, e.result?.resultText])
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
}

export function findEcho(
  entries: TimelineEntry[],
  uuid: string,
): { index: number; type: string; field: 'uuid' | 'user_message_uuid' }[] {
  const hits: { index: number; type: string; field: 'uuid' | 'user_message_uuid' }[] = [];
  entries.forEach((e, index) => {
    if (e.uuid === uuid) hits.push({ index, type: e.type, field: 'uuid' });
    if (e.userMessageUuid === uuid) hits.push({ index, type: e.type, field: 'user_message_uuid' });
  });
  return hits;
}

export function compact(e: TimelineEntry): string {
  const parts = [`t=${e.t}`, `type=${e.type}`];
  if (e.subtype !== undefined) parts.push(`subtype=${e.subtype}`);
  if (e.uuid !== undefined) parts.push(`uuid=${e.uuid}`);
  if (e.userMessageUuid !== undefined) parts.push(`user_message_uuid=${e.userMessageUuid}`);
  if (e.text !== undefined) parts.push(`text=${JSON.stringify(e.text)}`);
  if (e.toolUses !== undefined) {
    parts.push(`tool_use=${e.toolUses.map((u) => `${u.name}(${u.input})`).join(';')}`);
  }
  if (e.toolResults !== undefined) {
    parts.push(
      `tool_result=${e.toolResults.map((r) => `${r.toolUseId}${r.isError ? '!' : ''}:${JSON.stringify(r.content)}`).join(';')}`,
    );
  }
  if (e.result !== undefined) {
    parts.push(`result.subtype=${e.result.subtype}`);
    if (e.result.totalCostUsd !== undefined) parts.push(`cost=${e.result.totalCostUsd}`);
    if (e.result.numTurns !== undefined) parts.push(`num_turns=${e.result.numTurns}`);
  }
  return parts.join(' ');
}
