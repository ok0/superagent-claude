/** Linux sandbox through the adapter: a real dontAsk session with network.allow ['example.com'] fetches an allowed and a disallowed domain; the result is compared with probe().sandbox. Runs only on Linux with SUPERAGENT_CLAUDE_LIVE=1 and CLAUDE_CODE_OAUTH_TOKEN. Writes adapter.json to SANDBOX_LINUX_OUT when set. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '../../src/executor/contract.ts'
import { ClaudeRuntime } from '../../src/runtimes/claude/runtime.ts'
import { waitUntil } from '../fixtures/async.ts'
import { contractSpec } from '../fixtures/runtime-contract.ts'

const LIVE = process.env.SUPERAGENT_CLAUDE_LIVE === '1'
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
const CMD = "curl -sS -m 10 -o /dev/null -w 'A:%{http_code}\\n' https://example.com > net.txt 2>&1; curl -sS -m 10 -o /dev/null -w 'B:%{http_code}\\n' https://www.iana.org >> net.txt 2>&1"

function reachable(code: string | undefined): boolean {
  return code !== undefined && /^[23]\d\d$/.test(code)
}

describe.skipIf(!LIVE || !OAUTH || process.platform !== 'linux')('linux sandbox through the adapter', () => {
  it('reaches the allowed domain, blocks the other and matches probe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sac-sandbox-'))
    const cwd = join(root, 'work')
    execFileSync('git', ['init', '-q', cwd])
    const stderr: string[] = []
    const runtime = new ClaudeRuntime({
      mode: 'subscription',
      configDir: join(root, 'claude'),
      env: process.env,
      stderr: line => stderr.push(line),
    })
    const probe = await runtime.probe()
    const { spec } = contractSpec('followup starts a new turn', {
      cwd,
      instructions: 'Use your tools as asked.',
      tools: [],
      builtins: { fs: 'write', shell: true, web: false },
      network: { allow: ['example.com'] },
      limits: { maxTurns: 6, maxBudgetUsd: 0.3 },
      env: {},
      model: process.env.SUPERAGENT_CLAUDE_LIVE_MODEL ?? 'haiku',
    })
    const session = await runtime.open(spec)
    const events: RuntimeEvent[] = []
    void (async () => { for await (const event of session.events()) events.push(event) })()
    session.send({ id: 'A', text: `Use the Bash tool to run exactly this command and nothing else: ${CMD} . Then reply DONE.`, mode: 'followup' })
    await waitUntil(() => events.some(event => event.type === 'turnEnded' || event.type === 'error'), 300_000)
    await session.close()

    const netPath = join(cwd, 'net.txt')
    const net = existsSync(netPath) ? readFileSync(netPath, 'utf8') : ''
    const a = /A:(\d{3})/.exec(net)?.[1]
    const b = /B:(\d{3})/.exec(net)?.[1]
    const status = reachable(b) && probe.sandbox
      ? 'FAIL'
      : reachable(a) && b !== undefined && !reachable(b) && probe.sandbox
        ? 'PASS'
        : 'BLOCKED'

    const outDir = process.env.SANDBOX_LINUX_OUT ?? root
    mkdirSync(outDir, { recursive: true })
    const body = JSON.stringify({
      at: new Date().toISOString(),
      probe,
      codes: { a, b },
      net,
      events: events.map(e => e.type === 'error' ? { type: e.type, message: e.message } : { type: e.type }),
      stderrTail: stderr.slice(-40),
      status,
    }, null, 2).split(OAUTH ?? '').join('***')
    writeFileSync(join(outDir, 'adapter.json'), body)
    console.log(`[sandbox-linux] status=${status} probe.sandbox=${probe.sandbox} A=${a ?? 'none'} B=${b ?? 'none'}`)
    expect(status).not.toBe('FAIL')
  }, 600_000)
})
