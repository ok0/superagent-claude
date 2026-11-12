/**
 * Live guard check against the real SDK: a worker asked to push to a local bare remote gets a guard denial
 * reported through onDeny, without the command text; local repositories only, GitHub is never called.
 * Gated like claude-resume.spec.ts.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, RuntimeEvent } from '../../src/executor/contract.ts'
import type { AuthMode } from '../../src/runtimes/claude/options.ts'
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

function attemptedPush(transcripts: string[]): boolean {
  return transcripts.some(file =>
    readFileSync(file, 'utf8')
      .split('\n')
      .some(line => {
        if (!line.trim()) return false
        try {
          const entry = JSON.parse(line) as { message?: { content?: unknown } }
          const content = Array.isArray(entry.message?.content) ? entry.message.content : []
          return content.some(
            (block: { type?: string; name?: string; input?: { command?: unknown } }) =>
              block.type === 'tool_use' &&
              block.name === 'Bash' &&
              typeof block.input?.command === 'string' &&
              block.input.command.includes('git push'),
          )
        } catch {
          return false
        }
      }),
  )
}

describe.skipIf(!LIVE || !mode)('claude live guard denial', () => {
  it('a push attempt is denied through onDeny without the command text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sac-guard-'))
    const startedAt = new Date().toISOString()
    try {
      const origin = join(dir, 'origin.git')
      const work = join(dir, 'work')
      execFileSync('git', ['init', '--bare', '-b', 'main', origin])
      execFileSync('git', ['init', '-b', 'main', work])
      writeFileSync(join(work, 'README.md'), 'guard check\n')
      execFileSync('git', [...GIT, '-C', work, 'add', '-A'])
      execFileSync('git', [...GIT, '-C', work, 'commit', '-m', 'init'])
      execFileSync('git', ['-C', work, 'remote', 'add', 'origin', origin])

      const denials: ToolDenial[] = []
      const rt = new ClaudeRuntime({
        mode: mode!,
        configDir: join(dir, 'claude'),
        env: process.env,
        onDeny: d => denials.push(d),
      })
      const session = await rt.open({
        key: 'worker-guardcheck',
        role: 'worker',
        cwd: work,
        instructions: 'You are checking a local test repository. Follow the user message exactly.',
        tools: [],
        builtins: { fs: 'write', shell: true, web: false },
        network: { allow: [] },
        limits: { maxTurns: 6, maxBudgetUsd: 0.5 },
        env: {},
        model,
      })
      const events = watch(session)
      let turnEnded = false
      try {
        session.send({
          id: 'G1',
          text: 'Run this exact command once with the Bash tool: git push origin HEAD:main. Then reply with one line saying whether it worked.',
          mode: 'followup',
        })
        await waitUntil(() => {
          turnEnded = events.some(event => event.type === 'turnEnded')
          return turnEnded
        }, 180_000)
      } finally {
        await session.close()
      }

      const transcripts = walk(join(dir, 'claude', 'projects')).filter(file => file.endsWith('.jsonl'))
      const attempted = attemptedPush(transcripts)
      const refsOut = execFileSync('git', ['--git-dir', origin, 'for-each-ref'], { encoding: 'utf8' })
      expect(refsOut).toBe('')

      let verdict: 'PASS' | 'SKIP' | 'FAIL'
      if (denials.length >= 1) {
        verdict = 'PASS'
        for (const denial of denials) {
          expect(denial.key).toBe('worker-guardcheck')
          expect(denial.tool).toBe('Bash')
          expect(denial.reason).not.toContain('HEAD:main')
        }
      } else if (!attempted) {
        verdict = 'SKIP'
        console.log('[GUARD] SKIP model did not try')
      } else {
        verdict = 'FAIL'
      }
      console.log(`[GUARD] verdict=${verdict} denials=${denials.length} attempted=${attempted}`)

      const outDir = join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw')
      mkdirSync(outDir, { recursive: true })
      const stamp = startedAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
      const record = JSON.stringify({ verdict, denials, attempted, turnEnded, startedAt }, null, 2)
      expect(TOKENS.some(token => record.includes(token))).toBe(false)
      writeFileSync(join(outDir, `guard-denial-${stamp}.json`), record + '\n')

      expect(verdict).not.toBe('FAIL')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
