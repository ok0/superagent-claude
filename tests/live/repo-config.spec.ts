/**
 * Live check that repository auto-run settings do not run: a local repository with settings hooks, an MCP config and git hooks is opened by a real subscription session in a ticket worktree, and no marker outside the worktree appears. A trusted control shows the markers can be made. Gated by SUPERAGENT_CLAUDE_LIVE=1 and CLAUDE_CODE_OAUTH_TOKEN; skipped otherwise.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type { Ticket } from '../../src/core/index.ts'
import type { RuntimeEvent, SessionSpec } from '../../src/executor/contract.ts'
import { Workspaces } from '../../src/executor/workspaces.ts'
import { Commands } from '../../src/infra/commands.ts'
import { ClaudeRuntime, type QueryFn, type QueryHandle } from '../../src/runtimes/claude/runtime.ts'
import { waitUntil } from '../fixtures/async.ts'

const LIVE = process.env.SUPERAGENT_CLAUDE_LIVE === '1'
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
const MODEL = process.env.SUPERAGENT_CLAUDE_LIVE_MODEL ?? 'haiku'
const RAW = join(process.cwd(), '.docs', 'acceptance', 'raw')
const REPOSITORY = 'local/sample'
const KEEP = process.env.SUPERAGENT_CLAUDE_LIVE_KEEP === '1'
const roots: string[] = []

interface Observed {
  permissionModes: string[]
  tools: string[]
  mcpServers: string[]
  toolUses: { name: string; target?: string }[]
  denials: string[]
}

function stamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function sampleRepo(dir: string, markers: string): void {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', dir])
  const cmd = (name: string) => ({ type: 'command', command: 'touch ' + join(markers, name) })
  writeFileSync(join(dir, 'README.md'), '# Sample\n\nA sample repository.\n')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify(
      {
        enableAllProjectMcpServers: true,
        hooks: {
          SessionStart: [{ hooks: [cmd('settings-sessionstart')] }],
          UserPromptSubmit: [{ hooks: [cmd('settings-prompt')] }],
          PreToolUse: [{ matcher: '*', hooks: [cmd('settings-pretooluse')] }],
          PostToolUse: [{ matcher: '*', hooks: [cmd('settings-posttooluse')] }],
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          sample: {
            command: 'node',
            args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(markers, 'mcp'))}, '1')`],
          },
        },
      },
      null,
      2,
    ),
  )
  mkdirSync(join(dir, '.husky'), { recursive: true })
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push']) {
    const path = join(dir, '.husky', hook)
    writeFileSync(path, `#!/bin/sh\ntouch ${join(markers, 'git-' + hook)}\n`)
    chmodSync(path, 0o755)
  }
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      { name: 'sample', private: true, scripts: { prepare: 'git config core.hooksPath .husky' } },
      null,
      2,
    ),
  )
  const git = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=sample',
    '-c',
    'user.email=sample@example.invalid',
    '-c',
    'commit.gpgsign=false',
  ]
  execFileSync('git', [...git, '-C', dir, 'add', '-A'])
  execFileSync('git', [...git, '-C', dir, 'commit', '-q', '-m', 'chore: initial'])
}

function markersIn(dir: string): string[] {
  return readdirSync(dir).sort()
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map(part =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
  return ''
}

function record(o: Observed, message: unknown): void {
  const m = message as {
    type?: string
    subtype?: string
    permissionMode?: unknown
    tools?: unknown
    mcp_servers?: unknown
    message?: { content?: unknown }
  }
  if (m.type === 'system' && m.subtype === 'init') {
    if (typeof m.permissionMode === 'string') o.permissionModes.push(m.permissionMode)
    if (Array.isArray(m.tools)) o.tools.push(...m.tools.map(String))
    if (Array.isArray(m.mcp_servers))
      o.mcpServers.push(...m.mcp_servers.map(server => String((server as { name?: unknown }).name)))
    return
  }
  if (!Array.isArray(m.message?.content)) return
  for (const block of m.message.content as Array<Record<string, unknown>>) {
    if (m.type === 'assistant' && block.type === 'tool_use') {
      const input = (block.input ?? {}) as Record<string, unknown>
      const target =
        typeof input.command === 'string'
          ? input.command
          : typeof input.file_path === 'string'
            ? input.file_path
            : undefined
      o.toolUses.push({ name: String(block.name), target: target?.slice(0, 200) })
    }
    if (m.type === 'user' && block.type === 'tool_result') {
      const text = textOf(block.content)
      if (block.is_error === true || text.includes('is not allowed') || text.includes('go through the orchestrator_'))
        o.denials.push(text.slice(0, 300))
    }
  }
}

function tee(o: Observed): QueryFn {
  return params => {
    const q = sdkQuery(params)
    return {
      async *[Symbol.asyncIterator]() {
        for await (const m of q) {
          record(o, m)
          yield m
        }
      },
      interrupt: () => q.interrupt(),
      close: () => q.close(),
    } as QueryHandle
  }
}

async function setup(label: string) {
  const root = mkdtempSync(join(tmpdir(), 'sac-repo-config-'))
  roots.push(root)
  const markers = join(root, 'markers')
  mkdirSync(markers, { recursive: true })
  const upstream = join(root, 'upstream')
  sampleRepo(upstream, markers)
  const stateDir = join(root, 'state')
  const workspaces = new Workspaces({
    stateDir,
    commands: new Commands({ apiProgram: 'gh', baseEnv: process.env }),
    repositoryOf: () => REPOSITORY,
    access: { remote: () => upstream, env: () => ({}), secrets: [] },
  })
  const ticket = { id: 'repo-config-' + label } as unknown as Ticket
  await workspaces.prepare(ticket, 'repo-config-' + label)
  execFileSync('git', ['-C', workspaces.clonePath(REPOSITORY), 'config', 'core.hooksPath', '.husky'])
  const ws = await workspaces.prepare(ticket, 'repo-config-' + label)
  return { root, markers, stateDir, workspaces, ticket, ws }
}

let counter = 0

async function runSession(
  runtime: ClaudeRuntime,
  cwd: string,
  text: string,
): Promise<{ sessionId: string; events: RuntimeEvent[] }> {
  counter += 1
  const spec: SessionSpec = {
    key: 'repo-config-' + counter,
    role: 'worker',
    cwd,
    instructions: 'You work in a git repository. Use your tools.',
    tools: [],
    builtins: { fs: 'write', shell: true, web: false },
    network: { allow: [] },
    limits: { maxTurns: 12, maxBudgetUsd: 0.5 },
    env: {},
    model: MODEL,
  }
  const session = await runtime.open(spec)
  const events: RuntimeEvent[] = []
  const reader = (async () => {
    for await (const event of session.events()) events.push(event)
  })()
  session.send({ id: 'i1', text, mode: 'followup' })
  await waitUntil(() => events.some(event => event.type === 'turnEnded' || event.type === 'error'), 300_000)
  await session.close()
  await reader
  return { sessionId: session.sessionId, events }
}

function raw(
  caseName: 'untrusted' | 'control',
  ticketId: string,
  sessionId: string,
  worktree: string,
  markers: string[],
  observed: Observed,
  events: RuntimeEvent[],
  stderrLines: number,
  configDir: string,
): Record<string, unknown> {
  const turns = events.filter(
    (event): event is Extract<RuntimeEvent, { type: 'turnEnded' }> => event.type === 'turnEnded',
  )
  const last = turns[turns.length - 1]
  const errors = events.filter((event): event is Extract<RuntimeEvent, { type: 'error' }> => event.type === 'error')
  const projects = join(configDir, 'projects')
  const transcripts = existsSync(projects)
    ? readdirSync(projects, { recursive: true })
        .map(String)
        .filter(path => path.endsWith('.jsonl'))
    : []
  return {
    at: new Date().toISOString(),
    case: caseName,
    ticketId,
    sessionId,
    worktree,
    hooksPath: 'empty',
    markers,
    init: { permissionModes: observed.permissionModes, tools: observed.tools, mcpServers: observed.mcpServers },
    toolUses: observed.toolUses,
    denials: observed.denials,
    outcome: last ? last.outcome : errors.length ? errors[errors.length - 1]!.message : undefined,
    costUsd: last?.costUsd,
    stderrLines,
    transcripts,
  }
}

function writeRaw(file: string, record: Record<string, unknown>): void {
  mkdirSync(RAW, { recursive: true })
  writeFileSync(file, JSON.stringify(record, null, 2).split(OAUTH!).join('***'))
}

afterAll(() => {
  if (KEEP) return
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!LIVE || !OAUTH)('repository auto-run settings', () => {
  it('an untrusted repository runs no settings hook, MCP server or git hook', async () => {
    const { markers, stateDir, ws } = await setup('untrusted')
    expect(
      execFileSync('git', [
        '-C',
        join(stateDir, 'repos', REPOSITORY.replace('/', '__')),
        'config',
        '--get',
        'core.hooksPath',
      ])
        .toString()
        .trim(),
    ).toBe(join(stateDir, 'empty-hooks'))

    const observed: Observed = { permissionModes: [], tools: [], mcpServers: [], toolUses: [], denials: [] }
    const stderr: string[] = []
    const configDir = join(stateDir, 'claude')
    const runtime = new ClaudeRuntime({
      mode: 'subscription',
      configDir,
      env: process.env,
      query: tee(observed),
      stderr: line => stderr.push(line),
    })
    const { sessionId, events } = await runSession(
      runtime,
      ws.cwd,
      'Do these steps in order with your tools, then reply DONE. 1) Read README.md. 2) Create NOTES.md containing the word ok. 3) Run: git add NOTES.md && git commit -m "docs: add notes". 4) Run: git push origin HEAD. If a step fails, go on with the next step.',
    )

    const gitAs = ['-c', 'user.name=sample', '-c', 'user.email=sample@example.invalid', '-c', 'commit.gpgsign=false']
    execFileSync('git', ['-C', ws.cwd, ...gitAs, 'commit', '--allow-empty', '-q', '-m', 'test: host commit'])
    execFileSync('git', ['-C', ws.cwd, 'push', '-q', 'origin', 'HEAD:refs/heads/agent/repo-config-untrusted'])

    expect(markersIn(markers)).toEqual([])

    writeRaw(
      join(RAW, `repo-config-${stamp()}.json`),
      raw(
        'untrusted',
        'repo-config-untrusted',
        sessionId,
        basename(ws.cwd),
        markersIn(markers),
        observed,
        events,
        stderr.length,
        configDir,
      ),
    )
    console.log(
      `[PAC8] untrusted session=${sessionId} ticket=repo-config-untrusted markers=0 permissionMode=${[...new Set(observed.permissionModes)].join(',')} toolUses=${observed.toolUses.length} denials=${observed.denials.length}`,
    )
  }, 900_000)

  it('a trusted control runs the repository settings hooks and the git hooks', async () => {
    const { markers, stateDir, ws } = await setup('control')

    const observed: Observed = { permissionModes: [], tools: [], mcpServers: [], toolUses: [], denials: [] }
    const stderr: string[] = []
    const configDir = join(stateDir, 'claude')
    const runtime = new ClaudeRuntime({
      mode: 'subscription',
      configDir,
      env: process.env,
      query: tee(observed),
      stderr: line => stderr.push(line),
      trustRepoConfig: true,
    })
    const { sessionId, events } = await runSession(runtime, ws.cwd, 'Read README.md, then reply DONE.')
    expect(markersIn(markers).some(marker => marker.startsWith('settings-'))).toBe(true)

    execFileSync('git', [
      '-C',
      ws.cwd,
      '-c',
      'core.hooksPath=.husky',
      '-c',
      'user.name=sample',
      '-c',
      'user.email=sample@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'test: control',
    ])
    expect(markersIn(markers)).toContain('git-pre-commit')

    writeRaw(
      join(RAW, `repo-config-control-${stamp()}.json`),
      raw(
        'control',
        'repo-config-control',
        sessionId,
        basename(ws.cwd),
        markersIn(markers),
        observed,
        events,
        stderr.length,
        configDir,
      ),
    )
  }, 900_000)
})
