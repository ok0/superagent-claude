/** The host setting name check: the derived config key paths and the boundary rules of namesHostConfig. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CONFIG_KEY_PATHS, ConfigSchema, configKeyPaths } from '../src/app/config.ts'
import { namesHostConfig } from '../src/app/tools/tool.ts'
import { workspaceBlockedText } from '../src/core/replies.ts'

describe('host setting names', () => {
  it('derives the two-level config key paths from the schema', () => {
    expect(CONFIG_KEY_PATHS).toEqual(
      expect.arrayContaining(['network.allow', 'security.allowLocalBinding', 'workers.max', 'review.enabled']),
    )
    expect(CONFIG_KEY_PATHS.every(path => path.includes('.'))).toBe(true)
  })

  it('follows a schema extension', () => {
    const paths = configKeyPaths(
      ConfigSchema.extend({ extra: z.object({ knob: z.boolean() }).default({ knob: false }) }),
    )
    expect(paths).toContain('extra.knob')
    for (const path of CONFIG_KEY_PATHS) expect(paths).toContain(path)
  })

  it.each([
    ['Please allow proxy.golang.org in network.allow?', 'network.allow'],
    ['Edit issuecrew.json first', 'issuecrew.json'],
    ['Set network.allow.', 'network.allow'],
    ['(security.allowLocalBinding)', 'security.allowLocalBinding'],
  ])('names the setting in %j', (text, name) => {
    expect(namesHostConfig(text)).toBe(name)
  })

  it.each([
    'Which date format should the label use?',
    'the network allowlist',
    'an allowance',
    'mynetwork.allow',
    'network.allowed',
    'network.allow.extra',
    'Network.Allow',
    workspaceBlockedText(
      'owner/repo has no branch dev, so no workspace was made. A person must create the branch or change branchFrom or pullRequestTo for owner/repo in the config.',
    ),
  ])('leaves %j alone', text => {
    expect(namesHostConfig(text)).toBeUndefined()
  })
})
