/**
 * The GitHub Channel: replies go to the addressed repository only, a re-sent message posts once,
 * and a deleted target is gone.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Outbox } from '../src/app/outbox.ts'
import { databasePath, Store } from '../src/app/store.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { githubChannelAdapter } from '../src/sources/github/channel.ts'
import { githubChannel, GithubConfigSchema } from '../src/sources/github/trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { AGENT, fakeGh, issue } from './fixtures/fake-gh.ts'

const A = 'acme/widgets'
const B = 'acme/gadgets'
const issueUrl = (repository: string, number: number): string => `https://github.com/${repository}/issues/${number}`
const message = (id: string, repository: string, number: number, text: string, url?: string): OutboundMessage => ({
  id,
  channel: githubChannel(repository, number, url),
  text,
  kind: 'reply',
})
const repositories = (): Parameters<typeof fakeGh>[0] => ({
  repositories: { 'acme/widgets': { issues: { 5: issue(A, 5) } }, 'acme/gadgets': { issues: { 5: issue(B, 5) } } },
})

it('posts each reply to the repository its address names', async () => {
  const gh = fakeGh(repositories())
  const adapter = githubChannelAdapter({ commands: gh.commands, repositories: [A, B], login: () => AGENT })
  expect(await adapter.send(message('m1', A, 5, 'one', issueUrl(A, 5)))).toBe('sent')
  expect(await adapter.send(message('m2', B, 5, 'two', issueUrl(B, 5)))).toBe('sent')
  expect(gh.posted).toEqual([
    { repository: A, path: 'issues/5/comments', body: 'one\n\n<!-- issuecrew:m1 -->' },
    { repository: B, path: 'issues/5/comments', body: 'two\n\n<!-- issuecrew:m2 -->' },
  ])
})

it('allows replies only to configured repositories', async () => {
  const gh = fakeGh(repositories())
  const adapter = githubChannelAdapter({ commands: gh.commands, repositories: [A, B], login: () => AGENT })
  const registry = new SourceRegistry()
  registry.register({ kind: 'github', schema: GithubConfigSchema, channel: adapter })
  expect(registry.channelAllowed({ source: 'github', address: { repository: 'other/repo', number: '1' } })).toBe(false)
  expect(registry.channelAllowed({ source: 'github', address: { repository: 'ACME/Widgets', number: '5' } })).toBe(true)
  const before = gh.calls.length
  expect(await registry.send(message('m3', 'other/repo', 1, 'nope'))).toBe('gone')
  expect(gh.calls.length).toBe(before)
})

it('posts a re-sent message id once', async () => {
  const gh = fakeGh(repositories())
  const adapter = githubChannelAdapter({ commands: gh.commands, repositories: [A, B], login: () => AGENT })
  expect(await adapter.send(message('m1', A, 5, 'one'))).toBe('sent')
  expect(await adapter.send(message('m1', A, 5, 'one'))).toBe('sent')
  expect(gh.posted.length).toBe(1)
})

it('posts once through the Outbox for the same message id', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'github-channel-'))
  const store = new Store(databasePath(directory))
  try {
    const gh = fakeGh(repositories())
    const adapter = githubChannelAdapter({ commands: gh.commands, repositories: [A, B], login: () => AGENT })
    const registry = new SourceRegistry()
    registry.register({ kind: 'github', schema: GithubConfigSchema, channel: adapter })
    const clock = Date.parse('2026-09-09T00:00:00Z')
    const effects = new Effects(store, new HealthBoard(), () => clock)
    const outbox = new Outbox({
      store,
      effects,
      channels: {
        enabled: source => registry.enabled(source),
        allowed: channel => registry.channelAllowed(channel),
        send: outbound => registry.send(outbound),
      },
      paused: () => false,
    })
    effects.start()
    outbox.send(message('m1', A, 5, 'one'))
    outbox.send(message('m1', A, 5, 'one'))
    await outbox.sent()
    expect(gh.posted.length).toBe(1)
    expect(store.receipts.get('m1')!.status).toBe('sent')
    await effects.drain()
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('returns gone for a deleted target', async () => {
  const gh = fakeGh({ repositories: { 'acme/widgets': { failures: { 'issues/9/comments': 410 } } } })
  const adapter = githubChannelAdapter({ commands: gh.commands, repositories: [A, B], login: () => AGENT })
  expect(await adapter.send(message('m9', A, 9, 'gone soon'))).toBe('gone')
})

it('replies in a review thread', async () => {
  const url = 'https://github.com/acme/widgets/pull/9#discussion_r12'
  const gh = fakeGh({
    repositories: {
      'acme/widgets': {
        reviewComments: { 9: [{ id: 12, body: 'x', user: { login: 'carol', type: 'User' }, html_url: url }] },
      },
    },
  })
  const adapter = githubChannelAdapter({ commands: gh.commands, repositories: [A, B], login: () => AGENT })
  expect(await adapter.send(message('m12', A, 9, 'reply', url))).toBe('sent')
  expect(gh.posted).toEqual([
    { repository: A, path: 'pulls/9/comments/12/replies', body: 'reply\n\n<!-- issuecrew:m12 -->' },
  ])
})
