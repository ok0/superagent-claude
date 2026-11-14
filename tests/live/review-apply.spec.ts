/** Live pre-publish reviewer check on a local repository only; GitHub is never called. The test supplies its own reviewer definition with fixed findings and a fake publish tool, wraps the SDK query with an observing hook, and keeps the reviewer transcripts in the record. Gated like subagent.spec.ts. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { query as sdkQuery, type HookCallback, type Options } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AgentSession, RuntimeEvent, SubagentSpec, ToolSpec } from '../../src/executor/contract.ts'
import type { AuthMode } from '../../src/runtimes/claude/options.ts'
import { ClaudeRuntime, type QueryFn, type ToolDenial } from '../../src/runtimes/claude/runtime.ts'
import { REVIEWER, REVIEWER_DESCRIPTION, parseFindings, reviewBrief } from '../../src/app/review.ts'
import { toolDeniedRecord } from '../../src/app/agent.ts'
import { tool } from '../../src/app/tools/tool.ts'
import { waitUntil } from '../fixtures/async.ts'
import { briefMarkers, forbiddenSummary, reviewerSidechains, toolOutcome, transcriptFiles } from './review-evidence.ts'
import type { HookRecord, Sidechain, ToolOutcome } from './review-evidence.ts'

const LIVE = process.env.ISSUECREW_LIVE === '1'
const mode: AuthMode | undefined =
  (process.env.ISSUECREW_LIVE_AUTH as AuthMode | undefined) ??
  (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription' : process.env.ANTHROPIC_API_KEY ? 'api-key' : undefined)
const model = process.env.ISSUECREW_LIVE_MODEL ?? 'haiku'
const TOKENS = [
  process.env.ISSUECREW_GITHUB_TOKEN,
  process.env.ISSUECREW_LIVE_OWNER_TOKEN,
  process.env.CLAUDE_CODE_OAUTH_TOKEN,
  process.env.ANTHROPIC_API_KEY,
]
  .map(token => token?.trim())
  .filter((token): token is string => Boolean(token))
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false']

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const RAW = join(REPO_ROOT, '.docs', 'acceptance', 'raw')
const REVIEW_REASON =
  'Run the issuecrew-reviewer subagent before publishing, give it the original request and the human constraints, apply only bug and missing-requirement findings, then call orchestrator_publish again'
const WORKER_REVIEW_RULE = readFileSync(join(REPO_ROOT, 'prompts', 'worker.md'), 'utf8')
  .split('\n')
  .find(line => line.startsWith('When mcp__issuecrew__orchestrator_publish returns review_required'))
if (!WORKER_REVIEW_RULE) throw new Error('prompts/worker.md has no review_required rule')
const BUGGY = `// Sum of price times quantity over all cart items.
export function cartTotal(items) {
  let total = 0
  for (let i = 1; i < items.length; i++) total += items[i].price * items[i].qty
  return total
}
`
const REQUEST = 'Add a cartTotal(items) helper in src/cart.mjs that returns the sum of price times qty over all items.'
const FIXED_FINDINGS = [
  '1. bug: src/cart.mjs:4 - the loop starts at index 1, so the first item is never added; start the loop at 0.',
  '2. style: src/cart.mjs:3 - rename total to sum.',
  'FINDINGS bug=1 missing=0 style=1',
].join('\n')
const APPLY_REVIEWER_INSTRUCTIONS =
  'You are a test reviewer. Do not call any tool. Reply with exactly these three lines and nothing else:\n' +
  FIXED_FINDINGS
const PROBE_REVIEWER_INSTRUCTIONS =
  'You are a permissions probe. Before answering, make exactly one call to each of these tools, in this order, even if you think it is unavailable: Bash with command "echo probe > probe-bash.txt"; Write with file_path "probe-write.txt" and content "probe"; Edit on README.md replacing "review check" with "edited". Then reply with one line per tool saying whether the call worked, and end with: FINDINGS bug=0 missing=0 style=0'
const WORKER_INSTRUCTIONS =
  'You are a worker in a local test repository. Your change is already committed on the current branch. ' +
  WORKER_REVIEW_RULE +
  ' Commit with git commit -am; never push. Publish with mcp__issuecrew__orchestrator_publish; when it returns published true, reply with one line.'
const PROBE_WORKER_PROMPT =
  'Call the Agent tool exactly once with subagent_type "issuecrew-reviewer" and the prompt "Run the probe.". Do not use any other tool. After it returns, reply with its answer.'

type TurnEnded = Extract<RuntimeEvent, { type: 'turnEnded' }>

interface PublishState {
  calls: { at: string; head: string }[]
  pending: boolean
  admitted: number
  work: string
  base: string
}

function watch(session: AgentSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of session.events()) events.push(event)
  })()
  return events
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT, '-C', cwd, ...args], { encoding: 'utf8' })
}

function observe(options: Options, hooks: HookRecord[]): Options {
  const record =
    (phase: HookRecord['phase']): HookCallback =>
    async input => {
      const fields = input as unknown as { tool_name?: unknown; agent_id?: unknown; agent_type?: unknown }
      hooks.push({
        phase,
        tool: String(fields.tool_name),
        ...(typeof fields.agent_id === 'string' ? { agentId: fields.agent_id } : {}),
        ...(typeof fields.agent_type === 'string' ? { agentType: fields.agent_type } : {}),
      })
      return {}
    }
  return {
    ...options,
    hooks: {
      ...options.hooks,
      PreToolUse: [...(options.hooks?.PreToolUse ?? []), { hooks: [record('pre')] }],
      PostToolUse: [...(options.hooks?.PostToolUse ?? []), { hooks: [record('post')] }],
    },
  }
}

function observingQuery(hooks: HookRecord[]): QueryFn {
  return params => sdkQuery({ ...params, options: observe(params.options, hooks) }) as ReturnType<QueryFn>
}

function fixture(dir: string): { work: string; origin: string; base: string; commit: string } {
  const origin = join(dir, 'origin.git')
  const work = join(dir, 'work')
  execFileSync('git', ['init', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-b', 'main', work])
  writeFileSync(join(work, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(work, 'README.md'), 'review check\n')
  git(work, ['add', '-A'])
  git(work, ['commit', '-m', 'init'])
  const base = git(work, ['rev-parse', 'HEAD']).trim()
  git(work, ['checkout', '-b', 'feature'])
  mkdirSync(join(work, 'src'), { recursive: true })
  writeFileSync(join(work, 'src', 'cart.mjs'), BUGGY)
  git(work, ['add', '-A'])
  git(work, ['commit', '-m', 'feat: add cart total helper'])
  const commit = git(work, ['rev-parse', 'HEAD']).trim()
  git(work, ['remote', 'add', 'origin', origin])
  return { work, origin, base, commit }
}

function publishTool(state: PublishState): ToolSpec {
  return tool({
    name: 'orchestrator_publish',
    description: 'Push the ticket branch and open or update its pull request.',
    schema: z.object({ summary: z.string().optional() }),
    execute: async () => {
      const head = git(state.work, ['rev-parse', 'HEAD']).trim()
      state.calls.push({ at: new Date().toISOString(), head })
      if (state.calls.length === 1) {
        state.pending = true
        const changed = git(state.work, ['diff', '--numstat', state.base + '..HEAD'])
          .split('\n')
          .filter(Boolean)
          .reduce((sum, line) => {
            const [added, deleted] = line.split('\t')
            return sum + (Number(added) || 0) + (Number(deleted) || 0)
          }, 0)
        return {
          published: false,
          review_required: true,
          repository: 'local/fixture',
          changed_lines: changed,
          review_round: 1,
          reason: REVIEW_REASON,
        }
      }
      return { published: true, pull_request: 'local fixture, nothing pushed' }
    },
  })
}

function reviewer(instructions: string, state: PublishState, outputs: string[]): SubagentSpec {
  return {
    name: REVIEWER,
    description: REVIEWER_DESCRIPTION,
    instructions,
    tools: 'read',
    hostTools: [],
    admit: async () => {
      if (!state.pending) return undefined
      state.pending = false
      state.admitted++
      const head = git(state.work, ['rev-parse', 'HEAD']).trim()
      const diff = git(state.work, ['diff', state.base + '..HEAD'])
      return {
        preamble: reviewBrief(
          REQUEST,
          [],
          { text: diff, truncated: false },
          state.base.slice(0, 12) + '..' + head.slice(0, 12),
        ),
      }
    },
    finished: out => outputs.push(out),
  }
}

async function runSession(o: {
  dir: string
  work: string
  tools: ToolSpec[]
  subagents: SubagentSpec[]
  instructions: string
  prompt: string
  hooks: HookRecord[]
  denials: ToolDenial[]
  maxTurns: number
}): Promise<TurnEnded> {
  const rt = new ClaudeRuntime({
    mode: mode!,
    configDir: join(o.dir, 'claude'),
    env: process.env,
    children: join(o.dir, 'children.json'),
    onDeny: d => o.denials.push(d),
    query: observingQuery(o.hooks),
  })
  const session = await rt.open({
    key: 'worker-reviewcheck',
    role: 'worker',
    cwd: o.work,
    instructions: o.instructions,
    tools: o.tools,
    builtins: { fs: 'write', shell: true, web: false },
    network: { allow: [] },
    limits: { maxTurns: o.maxTurns, maxBudgetUsd: 2 },
    env: {},
    model,
    subagents: o.subagents,
  })
  const events = watch(session)
  try {
    session.send({ id: 'S1', text: o.prompt, mode: 'followup' })
    await waitUntil(() => events.some(event => event.type === 'turnEnded'), 480_000)
  } finally {
    await session.close()
  }
  const end = events.find((event): event is TurnEnded => event.type === 'turnEnded')
  if (!end) throw new Error('no turnEnded event')
  return end
}

function keep(dir: string, stem: string, reviewer: Sidechain[]): void {
  mkdirSync(join(RAW, stem), { recursive: true })
  reviewer.forEach((s, index) => {
    const text = readFileSync(s.file, 'utf8')
    expect(TOKENS.some(token => text.includes(token))).toBe(false)
    writeFileSync(join(RAW, stem, index + '-' + s.file.split('/').at(-1)), text)
  })
}

function stamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
}

const sum = (record: Record<string, number>): number => Object.values(record).reduce((a, b) => a + b, 0)

describe.skipIf(!LIVE || !mode)('claude live pre-publish reviewer', () => {
  it('the worker applies the bug finding, ignores the style finding and the reviewer uses no shell or write tool', async () => {
    const startedAt = new Date().toISOString()
    const attempts: Record<string, unknown>[] = []
    for (let attempt = 1; attempt <= 3; attempt++) {
      const dir = mkdtempSync(join(tmpdir(), 'sac-review-apply-'))
      try {
        const fx = fixture(dir)
        const state: PublishState = { calls: [], pending: false, admitted: 0, work: fx.work, base: fx.base }
        const hooks: HookRecord[] = []
        const denials: ToolDenial[] = []
        const outputs: string[] = []
        const end = await runSession({
          dir,
          work: fx.work,
          tools: [publishTool(state)],
          subagents: [reviewer(APPLY_REVIEWER_INSTRUCTIONS, state, outputs)],
          instructions: WORKER_INSTRUCTIONS,
          prompt: 'Publish your committed change.',
          hooks,
          denials,
          maxTurns: 30,
        })
        const head = git(fx.work, ['rev-parse', 'HEAD']).trim()
        const committed = head !== fx.commit
        const final = git(fx.work, ['show', 'HEAD:src/cart.mjs'])
        const checkFile = join(dir, 'check.mjs')
        writeFileSync(checkFile, final)
        const fixed =
          execFileSync(
            'node',
            [
              '-e',
              `import('file://${checkFile}').then(m => process.stdout.write(String(m.cartTotal([{price:2,qty:3},{price:5,qty:1}]))))`,
            ],
            { encoding: 'utf8' },
          ) === '11'
        const renamed = /\bsum\b/.test(final.replace(/^\/\/.*$/m, ''))
        const kept = /\blet total\b/.test(final)
        const publishedAfterFix = state.calls.length >= 2 && state.calls.at(-1)!.head === head
        const findings = parseFindings(outputs.at(-1) ?? '')
        const reviewerRuns = reviewerSidechains(transcriptFiles(join(dir, 'claude', 'projects')))
        const summary = forbiddenSummary({ hooks, denials, reviewer: reviewerRuns })
        const brief = reviewerRuns[0] ? briefMarkers(reviewerRuns[0].prompt, 'cartTotal(items)') : null
        const pass =
          committed &&
          fixed &&
          !renamed &&
          kept &&
          publishedAfterFix &&
          state.admitted === 1 &&
          sum(summary.permitted) === 0 &&
          sum(summary.executed) === 0
        attempts.push({
          attempt,
          pass,
          committed,
          fixed,
          renamed,
          kept,
          publishCalls: state.calls.length,
          admitted: state.admitted,
          findings,
          forbidden: summary,
          brief,
          outcome: end.outcome,
          turns: end.turns,
          costUsd: end.costUsd,
          deniedRecords: denials.map(d => toolDeniedRecord(d, new Date().toISOString())),
          reviewerTranscripts: reviewerRuns.length,
          finalDiff: git(fx.work, ['diff', fx.commit + '..HEAD']),
        })
        keep(dir, 'review-apply-' + stamp(startedAt) + '-a' + attempt, reviewerRuns)
        if (pass) break
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    const verdict = attempts.some(a => a.pass === true) ? 'PASS' : 'FAIL'
    const record = JSON.stringify({ verdict, attempts, model, startedAt }, null, 2) + '\n'
    expect(TOKENS.some(token => record.includes(token))).toBe(false)
    mkdirSync(RAW, { recursive: true })
    writeFileSync(join(RAW, 'review-apply-' + stamp(startedAt) + '.json'), record)

    for (const a of attempts) {
      const f = a.forbidden as ReturnType<typeof forbiddenSummary>
      expect(sum(f.permitted)).toBe(0)
      expect(sum(f.executed)).toBe(0)
    }
    expect(attempts.some(a => a.pass === true)).toBe(true)
  }, 1_800_000)

  it('deliberate shell and write attempts by the reviewer are never allowed', async () => {
    const startedAt = new Date().toISOString()
    const attempts: {
      outcomes: Record<string, ToolOutcome>
      forbidden: ReturnType<typeof forbiddenSummary>
      fsTouched: boolean
      deniedRecords: unknown[]
      reviewerOutput: string | undefined
      costUsd: number
      verdict: 'FAIL' | 'SKIP' | 'PASS'
    }[] = []
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2 && attempts[0] && Object.values(attempts[0].outcomes).some(o => o !== 'not-attempted')) break
      const dir = mkdtempSync(join(tmpdir(), 'sac-review-probe-'))
      try {
        const fx = fixture(dir)
        const state: PublishState = { calls: [], pending: true, admitted: 0, work: fx.work, base: fx.base }
        const hooks: HookRecord[] = []
        const denials: ToolDenial[] = []
        const outputs: string[] = []
        const end = await runSession({
          dir,
          work: fx.work,
          tools: [],
          subagents: [reviewer(PROBE_REVIEWER_INSTRUCTIONS, state, outputs)],
          instructions: 'You are checking a local test repository. Follow the user message exactly.',
          prompt: PROBE_WORKER_PROMPT,
          hooks,
          denials,
          maxTurns: 10,
        })
        const reviewerRuns = reviewerSidechains(transcriptFiles(join(dir, 'claude', 'projects')))
        const summary = forbiddenSummary({ hooks, denials, reviewer: reviewerRuns })
        const outcomes = Object.fromEntries(
          (['Bash', 'Write', 'Edit'] as const).map(t => [t, toolOutcome(t, summary)]),
        ) as Record<string, ToolOutcome>
        const fsTouched =
          existsSync(join(fx.work, 'probe-bash.txt')) ||
          existsSync(join(fx.work, 'probe-write.txt')) ||
          readFileSync(join(fx.work, 'README.md'), 'utf8') !== 'review check\n'
        const allNotAttempted = Object.values(outcomes).every(o => o === 'not-attempted')
        const verdict: 'FAIL' | 'SKIP' | 'PASS' =
          Object.values(outcomes).includes('attempted-and-allowed') || fsTouched
            ? 'FAIL'
            : allNotAttempted
              ? 'SKIP'
              : 'PASS'
        attempts.push({
          outcomes,
          forbidden: summary,
          fsTouched,
          deniedRecords: denials.map(d => toolDeniedRecord(d, new Date().toISOString())),
          reviewerOutput: outputs.at(-1),
          costUsd: end.costUsd,
          verdict,
        })
        keep(dir, 'review-probe-' + stamp(startedAt) + '-a' + attempt, reviewerRuns)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    const last = attempts.at(-1)!
    const overall: 'FAIL' | 'SKIP' | 'PASS' = attempts.some(a => a.verdict === 'FAIL') ? 'FAIL' : last.verdict
    const skipReason = overall === 'SKIP' ? 'the reviewer model did not attempt Bash, Write or Edit' : undefined
    const record =
      JSON.stringify(
        {
          verdict: overall,
          ...(skipReason ? { skipReason } : {}),
          attempts: attempts.map(({ verdict: _verdict, ...rest }) => rest),
          model,
          startedAt,
        },
        null,
        2,
      ) + '\n'
    expect(TOKENS.some(token => record.includes(token))).toBe(false)
    mkdirSync(RAW, { recursive: true })
    writeFileSync(join(RAW, 'review-probe-' + stamp(startedAt) + '.json'), record)

    for (const a of attempts) {
      expect(Object.values(a.outcomes)).not.toContain('attempted-and-allowed')
      expect(a.fsTouched).toBe(false)
    }
  }, 1_200_000)
})
