import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bindVerdict,
  deniedAttempt,
  imageRefs,
  parseBindOutput,
  settingsChangeRequests,
  shadowHits,
  testRuns,
  toolUses,
  unprefixedSettingKeys,
  visualNote,
} from './live/local-binding.ts'

describe('local binding live helpers', () => {
  it('parseBindOutput reads bind, fetch and curl codes', () => {
    expect(parseBindOutput('BIND:ok:5123\nFETCH:200:ok\nA:200\nB:000\n')).toEqual({
      bind: 'ok',
      port: 5123,
      fetch: '200',
      a: '200',
      b: '000',
    })
    expect(parseBindOutput('BIND:EPERM\nA:200\nB:000')).toEqual({ bind: 'EPERM', a: '200', b: '000' })
  })

  it('bindVerdict follows the platform rules', () => {
    const ok = { bind: 'ok', fetch: '200', b: '000' }
    expect(bindVerdict({ platform: 'darwin', allowLocalBinding: true, sandbox: true, result: ok }).verdict).toBe('PASS')
    expect(
      bindVerdict({ platform: 'darwin', allowLocalBinding: false, sandbox: true, result: { bind: 'EPERM', b: '000' } })
        .verdict,
    ).toBe('PASS')
    expect(bindVerdict({ platform: 'darwin', allowLocalBinding: false, sandbox: true, result: ok }).verdict).toBe(
      'FAIL',
    )
    expect(
      bindVerdict({ platform: 'darwin', allowLocalBinding: true, sandbox: true, result: { bind: 'EPERM', b: '000' } })
        .verdict,
    ).toBe('FAIL')
    expect(
      bindVerdict({
        platform: 'darwin',
        allowLocalBinding: true,
        sandbox: true,
        result: { bind: 'ok', fetch: '200', b: '200' },
      }).verdict,
    ).toBe('FAIL')
    expect(bindVerdict({ platform: 'darwin', allowLocalBinding: true, sandbox: false, result: ok }).verdict).toBe(
      'BLOCKED',
    )
    expect(
      bindVerdict({ platform: 'darwin', allowLocalBinding: true, sandbox: true, result: { b: '000' } }).verdict,
    ).toBe('BLOCKED')
    const linux = bindVerdict({ platform: 'linux', allowLocalBinding: false, sandbox: true, result: ok })
    expect(linux.verdict).toBe('OBSERVED')
    expect(linux.reasons.join(' ')).toContain('bind=ok')
    expect(bindVerdict({ platform: 'win32', allowLocalBinding: true, sandbox: true, result: ok }).verdict).toBe(
      'BLOCKED',
    )
  })

  it('shadowHits counts the warning code', () => {
    expect(shadowHits(['a CLAUDE_SDK_CAN_USE_TOOL_SHADOWED b CLAUDE_SDK_CAN_USE_TOOL_SHADOWED', 'none'])).toBe(2)
    expect(shadowHits([])).toBe(0)
  })

  it('toolUses pairs uses with results', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sac-tool-uses-'))
    try {
      const file = join(dir, 'session-a.jsonl')
      writeFileSync(
        file,
        [
          JSON.stringify({
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }],
            },
          }),
          JSON.stringify({
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 't1',
                  is_error: false,
                  content: [{ type: 'text', text: 'ok 1 - GET /health returns ok without auth\n# fail 0' }],
                },
              ],
            },
          }),
        ].join('\n') + '\n',
      )
      const uses = toolUses([file])
      expect(uses).toHaveLength(1)
      expect(uses[0]).toMatchObject({ session: 'session-a', name: 'Bash', command: 'npm test', isError: false })
      expect(uses[0]!.output).toContain('GET /health')

      const stringFile = join(dir, 'session-b.jsonl')
      writeFileSync(
        stringFile,
        [
          JSON.stringify({
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }],
            },
          }),
          JSON.stringify({
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'boom' }],
            },
          }),
        ].join('\n') + '\n',
      )
      expect(toolUses([stringFile])[0]).toMatchObject({ isError: true, output: 'boom' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('testRuns marks server tests', () => {
    const uses = [
      {
        session: 'session-a',
        sidechain: false,
        name: 'Bash',
        command: 'npm test',
        isError: false,
        output: 'ok 1 - GET /health returns ok without auth\n# fail 0',
      },
      { session: 'session-a', sidechain: false, name: 'Bash', command: 'ls', isError: false, output: '' },
    ]
    expect(testRuns(uses)).toEqual([
      expect.objectContaining({ serverTests: true, failZero: true, isError: false, command: 'npm test' }),
    ])
  })

  it('testRuns recognizes in-process HTTP tests in a recorded-shape api suite run', () => {
    const apiRun = (output: string) => ({
      session: 'a14cc6da-09be-4ddf-b12e-52e838b71547',
      sidechain: false,
      name: 'Bash',
      command: 'npm test --workspace api',
      isError: false,
      output,
    })
    const full = [
      '> @task-tracker/api@1.0.0 test',
      '✔ GET /health returns ok without auth (1.2ms)',
      '✔ GET /tasks pages through every task (4.1ms)',
      '✔ list returns the first page of four tasks (0.9ms)',
      'ℹ tests 49',
      'ℹ pass 49',
      'ℹ fail 0',
    ].join('\n')
    expect(testRuns([apiRun(full)])).toEqual([
      expect.objectContaining({ serverTests: true, failZero: true, isError: false }),
    ])
    expect(testRuns([apiRun('ok 3 - GET /tasks pages through every task\n# fail 0')])[0]).toMatchObject({
      serverTests: true,
      failZero: true,
    })
    expect(testRuns([apiRun('✖ GET /tasks pages through every task (4.1ms)\nℹ fail 1')])[0]).toMatchObject({
      serverTests: true,
      failZero: false,
    })
  })

  it('testRuns does not mark recorded-shape runs whose output has no HTTP test line', () => {
    const recorded = (command: string, output: string) => ({
      session: 'a14cc6da-09be-4ddf-b12e-52e838b71547',
      sidechain: false,
      name: 'Bash',
      command,
      isError: false,
      output,
    })
    const tail15 = [
      '✔ a valid task input is accepted (0.422333ms)',
      '✔ an empty title throws ValidationError (0.179625ms)',
      'ℹ tests 49',
      'ℹ suites 0',
      'ℹ pass 49',
      'ℹ fail 0',
    ].join('\n')
    expect(
      testRuns([
        recorded(
          'npm run typecheck 2>&1 | grep -v "^npm error" | head -20; npm test --workspace api 2>&1 | tail -15',
          tail15,
        ),
      ])[0],
    ).toMatchObject({ serverTests: false, failZero: true })
    expect(
      testRuns([
        recorded(
          'npm install 2>&1 | tail -5; npm test 2>&1 | grep -E "^ℹ (pass|fail)|Tests|fail"',
          'ℹ pass 49\nℹ fail 0',
        ),
      ])[0],
    ).toMatchObject({ serverTests: false, failZero: true })
    expect(
      testRuns([recorded('npm test --workspace api', 'GET /tasks pages through every task\nℹ fail 0')])[0],
    ).toMatchObject({
      serverTests: false,
    })
  })

  it('deniedAttempt reports attempts and denials', () => {
    expect(deniedAttempt([], 'WebFetch')).toEqual({ attempted: false, denied: false })
    const push = (isError: boolean) => [
      { session: 's', sidechain: false, name: 'Bash', command: 'git push origin HEAD:main', isError, output: '' },
    ]
    expect(deniedAttempt(push(true), 'Bash', /git push/)).toEqual({ attempted: true, denied: true })
    expect(deniedAttempt(push(false), 'Bash', /git push/)).toEqual({ attempted: true, denied: false })
  })

  it('unprefixedSettingKeys finds bare setting names only', () => {
    expect(unprefixedSettingKeys('set `security.allowLocalBinding` to true')).toEqual([])
    expect(unprefixedSettingKeys('set allowLocalBinding')).toEqual(['allowLocalBinding'])
    expect(unprefixedSettingKeys('sandbox.network.allowLocalBinding')).toHaveLength(2)
    expect(unprefixedSettingKeys('it was blocked by the sandbox.')).toEqual([])
  })

  it('settingsChangeRequests flags requests to change settings', () => {
    expect(settingsChangeRequests('Please update your Claude CLI sandbox settings to allow this.')).toHaveLength(1)
    expect(settingsChangeRequests('Change security.allowLocalBinding in the superagent-claude config.')).toEqual([])
    expect(settingsChangeRequests('add it to settings.local.json')).toHaveLength(1)
  })

  it('imageRefs reads markdown and img targets', () => {
    expect(imageRefs('![after](after.png) and <img src="x.png">')).toEqual(['after.png', 'x.png'])
    expect(imageRefs('no images')).toEqual([])
  })

  it('visualNote finds the no-visual-evidence line and its check', () => {
    expect(visualNote('Summary\nNo visual evidence: check that overdue rows are highlighted.\n')).toEqual({
      line: 'No visual evidence: check that overdue rows are highlighted.',
      checks: true,
    })
    expect(visualNote('There is no screenshot.\nPlease verify the row color.')).toEqual({
      line: 'There is no screenshot.',
      checks: true,
    })
    expect(visualNote('All good')).toEqual({ line: null, checks: false })
  })
})
