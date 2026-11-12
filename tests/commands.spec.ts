/** The subprocess runner: whitelisted environment, API-only variables, sanitized errors and the path root. */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CliError, Commands, commandError, type Exec, type Tally } from '../src/infra/commands.ts'
import { subprocessEnv } from '../src/infra/env.ts'

const ok = () => vi.fn<Exec>(async () => ({ stdout: '{}' }))

describe('Commands', () => {
  it('passes only PATH, HOME, LANG and the named API variables to the API program, and no API variables to git', async () => {
    const exec = ok()
    const commands = new Commands({
      apiProgram: 'gh',
      baseEnv: {
        PATH: '/bin',
        HOME: '/h',
        LANG: 'C',
        ANTHROPIC_API_KEY: 'k',
        SUPERAGENT_CLAUDE_GITHUB_TOKEN: 't',
        AWS_SECRET_ACCESS_KEY: 's',
        GH_TOKEN: 'leak',
      },
      apiEnv: { GH_TOKEN: 't' },
      exec,
    })
    await commands.call(['api', 'user'])
    expect(exec.mock.calls[0]![2].env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C', GH_TOKEN: 't' })
    await commands.git(['status'], '/tmp')
    expect(exec.mock.calls[1]![2].env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C' })
  })

  it('subprocessEnv omits unset whitelist keys', () => {
    expect(subprocessEnv({ PATH: '/bin' }, { X: '1' })).toEqual({ PATH: '/bin', X: '1' })
  })

  it('prefixes API paths with the root and refuses escaping paths without running anything', async () => {
    const exec = ok()
    const commands = new Commands({ apiProgram: 'gh', baseEnv: {}, exec })
    await commands.at('repos/acme/widgets').api('issues/1')
    expect(exec.mock.calls[0]![1]).toEqual(['api', 'repos/acme/widgets/issues/1'])
    exec.mockClear()
    for (const path of ['../x', '/user', 'https://evil', 'issues/../../x']) {
      await expect(commands.at('repos/acme/widgets').api(path)).rejects.toThrow('restricted')
    }
    expect(exec).not.toHaveBeenCalled()
  })

  it('turns failures into CliError with the HTTP status and without argv', async () => {
    const httpFailure = Object.assign(new Error('failed'), { stderr: 'gh: Not Found (HTTP 404)', code: 1 })
    const failing = new Commands({
      apiProgram: 'gh',
      baseEnv: {},
      exec: vi.fn(async () => {
        throw httpFailure
      }),
    })
    const error = await failing.call(['api', 'x', '-f', 'body=secret-body']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe(404)
    expect((error as Error).message).not.toContain('secret-body')

    const jsonFailure = Object.assign(new Error('failed'), {
      stderr: '{"error":{"code":410,"message":"Gone"}}',
      code: 1,
    })
    const gone = new Commands({
      apiProgram: 'gh',
      baseEnv: {},
      exec: vi.fn(async () => {
        throw jsonFailure
      }),
    })
    const goneError = await gone.call(['api', 'x']).catch((caught: unknown) => caught)
    expect((goneError as CliError).code).toBe(410)

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const aborted = new Commands({
      apiProgram: 'gh',
      baseEnv: {},
      exec: vi.fn(async () => {
        throw abort
      }),
    })
    await expect(aborted.call(['api', 'x'])).rejects.toBe(abort)
  })

  it('reads all pages and skips invalid items', async () => {
    const exec = vi.fn<Exec>(async () => ({ stdout: JSON.stringify([[{ id: 1 }, { id: 'x' }], [{ id: 2 }]]) }))
    const commands = new Commands({ apiProgram: 'gh', baseEnv: {}, exec })
    const tally: Tally = { skipped: 0 }
    const items = await commands.pages(z.object({ id: z.number() }), 'issues', tally)
    expect(items).toEqual([{ id: 1 }, { id: 2 }])
    expect(tally.skipped).toBe(1)
    const args = exec.mock.calls[0]![1]
    expect(args.slice(-2)).toEqual(['--paginate', '--slurp'])
  })

  it('uses a per-call timeout for git and keeps the default otherwise', async () => {
    const exec = ok()
    const commands = new Commands({ apiProgram: 'gh', baseEnv: {}, exec })
    await commands.git(['status'], '/tmp')
    expect(exec.mock.calls[0]![2].timeout).toBe(90_000)
    await commands.git(['log'], '/tmp', {}, { timeoutMs: 10_000 })
    expect(exec.mock.calls[1]![2].timeout).toBe(10_000)
  })

  it('names the actual timeout in a timed-out error', () => {
    expect(
      commandError(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }), 'git', 10_000).message,
    ).toBe('git timed out after 10 s')
  })
})
