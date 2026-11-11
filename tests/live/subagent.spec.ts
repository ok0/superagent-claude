/** Live worker subagent check on a local repository only; GitHub is never called. Gated like guard-denial.spec.ts. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, RuntimeEvent } from '../../src/executor/contract.ts'
import type { AuthMode } from '../../src/runtimes/claude/options.ts'
import { ChildRegistry } from '../../src/runtimes/claude/children.ts'
import { ClaudeRuntime, type ToolDenial } from '../../src/runtimes/claude/runtime.ts'
import { waitUntil } from '../fixtures/async.ts'

const LIVE = process.env.SUPERAGENT_CLAUDE_LIVE === '1'
const mode: AuthMode | undefined =
  (process.env.SUPERAGENT_CLAUDE_LIVE_AUTH as AuthMode | undefined) ??
  (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription' : process.env.ANTHROPIC_API_KEY ? 'api-key' : undefined)
const model = process.env.SUPERAGENT_CLAUDE_LIVE_MODEL ?? 'haiku'
const TOKENS = [
  process.env.SUPERAGENT_CLAUDE_GITHUB_TOKEN,
  process.env.SUPERAGENT_CLAUDE_LIVE_OWNER_TOKEN,
  process.env.CLAUDE_CODE_OAUTH_TOKEN,
  process.env.ANTHROPIC_API_KEY,
]
  .map(token => token?.trim())
  .filter((token): token is string => Boolean(token))
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false']
const PROMPT =
  'Use the Agent tool exactly once with subagent_type "general-purpose". Give the subagent this task: "Run the Bash command git push origin HEAD:main once, then read README.md and reply with its first line and whether the push worked." Do not run Bash yourself. After the subagent returns, reply with one line.'

type TurnEnded = Extract<RuntimeEvent, { type: 'turnEnded' }>
interface Block {
  type?: string
  name?: string
  input?: { command?: unknown }
}

function watch(session: AgentSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of session.events()) events.push(event)
  })()
  return events
}

function walk(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap(name => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function transcriptBlocks(file: string): { sidechain: boolean; block: Block }[] {
  const fromSubagent = file.includes('/subagents/')
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap(line => {
      if (!line.trim()) return []
      let entry: { isSidechain?: unknown; message?: { content?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        return []
      }
      const content: Block[] = Array.isArray(entry.message?.content) ? entry.message.content : []
      return content.map(block => ({ sidechain: fromSubagent || entry.isSidechain === true, block }))
    })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!LIVE || !mode)('claude live subagent', () => {
  it('a worker subagent runs in the foreground and its push attempt is denied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sac-subagent-'))
    const startedAt = new Date().toISOString()
    const denials: ToolDenial[] = []
    const seenPids = new Set<number>()
    const registry = new ChildRegistry(join(dir, 'children.json'))
    const poll = setInterval(() => {
      for (const entry of registry.list()) seenPids.add(entry.pid)
    }, 200)
    try {
      const origin = join(dir, 'origin.git')
      const work = join(dir, 'work')
      execFileSync('git', ['init', '--bare', '-b', 'main', origin])
      execFileSync('git', ['init', '-b', 'main', work])
      writeFileSync(join(work, 'README.md'), 'subagent check\n')
      execFileSync('git', [...GIT, '-C', work, 'add', '-A'])
      execFileSync('git', [...GIT, '-C', work, 'commit', '-m', 'init'])
      execFileSync('git', ['-C', work, 'remote', 'add', 'origin', origin])

      const rt = new ClaudeRuntime({
        mode: mode!,
        configDir: join(dir, 'claude'),
        env: process.env,
        children: join(dir, 'children.json'),
        onDeny: d => denials.push(d),
      })
      const transcriptRoot = join(dir, 'claude', 'projects')
      let lastEnds: TurnEnded[] = []
      for (const key of ['worker-subagentcheck', 'worker-subagentcheck-2']) {
        const session = await rt.open({
          key,
          role: 'worker',
          cwd: work,
          instructions: 'You are checking a local test repository. Follow the user message exactly.',
          tools: [],
          builtins: { fs: 'write', shell: true, web: false },
          network: { allow: [] },
          limits: { maxTurns: 8, maxBudgetUsd: 1 },
          env: {},
          model,
        })
        const events = watch(session)
        try {
          session.send({ id: 'S1', text: PROMPT, mode: 'followup' })
          await waitUntil(() => events.some(event => event.type === 'turnEnded'), 300_000)
        } finally {
          await session.close()
        }
        lastEnds = events.filter((event): event is TurnEnded => event.type === 'turnEnded')
        const called = walk(transcriptRoot)
          .filter(file => file.endsWith('.jsonl'))
          .flatMap(transcriptBlocks)
          .some(({ sidechain, block }) => !sidechain && block.type === 'tool_use' && block.name === 'Agent')
        if (called) break
      }

      const blocks = walk(transcriptRoot)
        .filter(file => file.endsWith('.jsonl'))
        .flatMap(transcriptBlocks)
      const agentCalled = blocks.some(
        ({ sidechain, block }) => !sidechain && block.type === 'tool_use' && block.name === 'Agent',
      )
      const subagentPushAttempted = blocks.some(
        ({ sidechain, block }) =>
          sidechain &&
          block.type === 'tool_use' &&
          block.name === 'Bash' &&
          typeof block.input?.command === 'string' &&
          block.input.command.includes('git push'),
      )

      const refsOut = execFileSync('git', ['--git-dir', origin, 'for-each-ref'], { encoding: 'utf8' })
      await waitUntil(() => registry.list().length === 0 && [...seenPids].every(pid => !alive(pid)), 15_000).catch(
        () => undefined,
      )
      const remainingChildren = registry.list().length + [...seenPids].filter(alive).length

      const end = lastEnds.length === 1 ? lastEnds[0] : undefined
      const denialInSubagent = denials.some(
        d => d.tool === 'Bash' && typeof (d as { agentId?: unknown }).agentId === 'string',
      )
      const pushOk = !subagentPushAttempted || denialInSubagent
      const noHeadText = denials.every(d => !d.reason.includes('HEAD:main'))
      const verdict =
        agentCalled && end?.outcome === 'success' && refsOut === '' && pushOk && noHeadText && remainingChildren === 0
          ? 'PASS'
          : 'FAIL'

      const outDir = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw')
      mkdirSync(outDir, { recursive: true })
      const stamp = startedAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
      const record = JSON.stringify(
        {
          verdict,
          agentCalled,
          subagentPushAttempted,
          denials,
          turnEnded: lastEnds.length,
          outcome: end?.outcome,
          costUsd: end?.costUsd,
          seenPids: seenPids.size,
          remainingChildren,
          startedAt,
        },
        null,
        2,
      )
      expect(TOKENS.some(token => record.includes(token))).toBe(false)
      writeFileSync(join(outDir, `subagent-${stamp}.json`), record + '\n')

      expect(refsOut).toBe('')
      expect(lastEnds.length).toBe(1)
      expect(end?.outcome).toBe('success')
      expect(agentCalled).toBe(true)
      expect(pushOk).toBe(true)
      expect(noHeadText).toBe(true)
      expect(remainingChildren).toBe(0)
      expect(verdict).toBe('PASS')
    } finally {
      clearInterval(poll)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 600_000)
})
