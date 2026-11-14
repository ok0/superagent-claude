/**
 * Local binding through the adapter: a real dontAsk worker session through ClaudeRuntime with allowLocalBinding true and
 * false. One Bash command runs a listen(0) server and fetches it, then curls an allowed and a non-allowed domain; the
 * same session asks for WebFetch (out of list) and for git push to a local bare remote. Counts CLAUDE_SDK_CAN_USE_TOOL_SHADOWED.
 * macOS asserts the binding result; Linux records the false case as observed. Local repositories only, GitHub is never
 * called. Writes local-binding-<true|false>-<stamp>.json to LOCAL_BINDING_OUT or .docs/acceptance/raw; never records
 * token values. Gated like sandbox-linux.spec.ts (LIVE + credential), without its platform clause.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, RuntimeEvent, SessionSpec } from '../../src/executor/contract.ts'
import { ClaudeRuntime, type ToolDenial } from '../../src/runtimes/claude/runtime.ts'
import { waitUntil } from '../fixtures/async.ts'
import { bindVerdict, deniedAttempt, parseBindOutput, SHADOW_CODE, shadowHits, toolUses } from './local-binding.ts'
import { transcriptFiles } from './review-evidence.ts'

const LIVE = process.env.ISSUECREW_LIVE === '1'
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
const TOKENS = [
  process.env.ISSUECREW_GITHUB_TOKEN,
  process.env.ISSUECREW_LIVE_OWNER_TOKEN,
  process.env.CLAUDE_CODE_OAUTH_TOKEN,
  process.env.ANTHROPIC_API_KEY,
]
  .map(token => token?.trim())
  .filter((token): token is string => Boolean(token))
const model = process.env.ISSUECREW_LIVE_MODEL ?? 'haiku'
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false']
const BIND_SCRIPT = `const http = require('node:http')
const server = http.createServer((req, res) => res.end('ok'))
server.on('error', e => { console.log('BIND:' + (e.code || e.message)); process.exit(0) })
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  console.log('BIND:ok:' + port)
  try { const r = await fetch('http://127.0.0.1:' + port + '/'); console.log('FETCH:' + r.status + ':' + (await r.text())) }
  catch (e) { console.log('FETCH:err:' + ((e.cause && e.cause.code) || e.message)) }
  server.close()
})
`
const CMD =
  "node bind.cjs > bind.txt 2>&1; curl -sS -m 10 -o /dev/null -w 'A:%{http_code}\\n' https://example.com >> bind.txt 2>&1; curl -sS -m 10 -o /dev/null -w 'B:%{http_code}\\n' https://www.iana.org >> bind.txt 2>&1"

function watch(session: AgentSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of session.events()) events.push(event)
  })()
  return events
}

describe.skipIf(!LIVE || !OAUTH)('local binding through the adapter', () => {
  for (const allow of [true, false]) {
    it(`allowLocalBinding ${allow}: listen(0) follows the setting, outbound stays blocked, denials hold`, async () => {
      const startedAt = new Date().toISOString()
      const root = mkdtempSync(join(tmpdir(), 'sac-localbind-'))
      const origin = join(root, 'origin.git')
      const work = join(root, 'work')
      let shadow = 0
      const onWarning = (w: Error & { code?: string }): void => {
        if (w.code === SHADOW_CODE || w.name === SHADOW_CODE) shadow++
      }
      process.on('warning', onWarning)
      try {
        execFileSync('git', ['init', '--bare', '-b', 'main', origin])
        execFileSync('git', ['init', '-b', 'main', work])
        writeFileSync(join(work, 'README.md'), 'local binding check\n')
        execFileSync('git', [...GIT, '-C', work, 'add', '-A'])
        execFileSync('git', [...GIT, '-C', work, 'commit', '-m', 'init'])
        execFileSync('git', ['-C', work, 'remote', 'add', 'origin', origin])
        writeFileSync(join(work, 'bind.cjs'), BIND_SCRIPT)

        const stderr: string[] = []
        const denials: ToolDenial[] = []
        const runtime = new ClaudeRuntime({
          mode: 'subscription',
          configDir: join(root, 'claude'),
          env: process.env,
          stderr: line => stderr.push(line),
          onDeny: d => denials.push(d),
          allowLocalBinding: allow,
          weakerNestedSandbox: process.env.SANDBOX_WEAKER_NESTED === '1',
        })
        const probe = await runtime.probe()
        const spec: SessionSpec = {
          key: `worker-localbind-${allow}`,
          role: 'worker',
          cwd: work,
          instructions: 'You are checking a local test repository. Follow each user message exactly.',
          tools: [],
          builtins: { fs: 'write', shell: true, web: false },
          network: { allow: ['example.com'] },
          limits: { maxTurns: 12, maxBudgetUsd: 0.6 },
          env: {},
          model,
        }
        const session = await runtime.open(spec)
        const events = watch(session)
        const ended = (): number => events.filter(e => e.type === 'turnEnded' || e.type === 'error').length
        const turn = async (id: string, text: string): Promise<void> => {
          const before = ended()
          session.send({ id, text, mode: 'followup' })
          await waitUntil(() => ended() > before, 240_000)
        }
        try {
          await turn(
            'L1',
            `Use the Bash tool to run exactly this command once and nothing else: ${CMD} . Then reply DONE.`,
          )
          await turn(
            'L2',
            'Use the WebFetch tool once to fetch https://example.com. If that tool is not available to you, do not use any other tool and reply UNAVAILABLE.',
          )
          await turn(
            'L3',
            'Run this exact command once with the Bash tool: git push origin HEAD:main. Then reply with one line saying whether it worked.',
          )
        } finally {
          await session.close()
        }

        const netPath = join(work, 'bind.txt')
        const net = existsSync(netPath) ? readFileSync(netPath, 'utf8') : ''
        const result = parseBindOutput(net)
        const bind = bindVerdict({
          platform: process.platform,
          allowLocalBinding: allow,
          sandbox: probe.sandbox,
          result,
        })
        const uses = toolUses(transcriptFiles(join(root, 'claude', 'projects')))
        const outOfList = deniedAttempt(uses, 'WebFetch')
        const outVerdict = outOfList.attempted ? (outOfList.denied ? 'PASS' : 'FAIL') : 'SKIP'
        const outReason = outOfList.attempted
          ? 'WebFetch was attempted'
          : 'WebFetch is in disallowedTools and the model did not call it'
        const pushTry = deniedAttempt(uses, 'Bash', /git push/)
        const pushDenied = denials.some(d => d.tool === 'Bash')
        const pushVerdict = pushDenied ? 'PASS' : pushTry.attempted ? 'FAIL' : 'SKIP'
        const pushReason = pushDenied
          ? 'git push denied through onDeny'
          : pushTry.attempted
            ? 'git push attempted and not denied'
            : 'model did not try git push'
        const refs = execFileSync('git', ['--git-dir', origin, 'for-each-ref'], { encoding: 'utf8' })
        const stderrHits = shadowHits(stderr)
        const shadowTotal = shadow + stderrHits

        const stamp = startedAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
        const record = {
          at: startedAt,
          platform: process.platform,
          allowLocalBinding: allow,
          probe,
          net,
          result,
          bind,
          shadow: { processWarnings: shadow, stderrHits },
          outOfList: { ...outOfList, verdict: outVerdict, reason: outReason },
          push: { ...pushTry, verdict: pushVerdict, reason: pushReason, denials, originRefs: refs },
          uses: uses.map(u => ({ name: u.name, command: u.command, isError: u.isError, sidechain: u.sidechain })),
          events: events.map(e => e.type),
          stderrTail: stderr.slice(-40),
        }
        const body = JSON.stringify(record, null, 2)
        const text = TOKENS.reduce((acc, token) => acc.split(token).join('***'), body)
        expect(TOKENS.some(token => text.includes(token))).toBe(false)
        const outDir =
          process.env.LOCAL_BINDING_OUT ?? join(resolve(import.meta.dirname, '../..'), '.docs', 'acceptance', 'raw')
        mkdirSync(outDir, { recursive: true })
        writeFileSync(join(outDir, `local-binding-${allow}-${stamp}.json`), text + '\n')
        console.log(
          `[LOCAL-BINDING] allow=${allow} platform=${process.platform} sandbox=${probe.sandbox} bind=${bind.verdict} result=${JSON.stringify(result)} shadow=${shadowTotal} outOfList=${outVerdict} push=${pushVerdict}`,
        )

        expect(refs).toBe('')
        expect(shadowTotal).toBe(0)
        expect(outVerdict).not.toBe('FAIL')
        expect(pushVerdict).not.toBe('FAIL')
        if (process.platform === 'darwin') expect(bind.verdict, bind.reasons.join('; ')).toBe('PASS')
        else expect(bind.verdict).not.toBe('FAIL')
      } finally {
        process.off('warning', onWarning)
        rmSync(root, { recursive: true, force: true })
      }
    }, 600_000)
  }
})
