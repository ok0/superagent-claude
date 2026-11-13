/**
 * The Source kinds this build installs: the GitHub Source when SUPERAGENT_CLAUDE_GITHUB_TOKEN is set.
 * The token reaches only the GitHub API client and never a subprocess environment. A missing or blank token refuses startup.
 * The token also authenticates the host's clone and fetch calls and pull request writes, through an
 * env-scoped header that never reaches worker sessions or git config.
 */
import { Buffer } from 'node:buffer'
import type { Config } from './config.ts'
import { StartupRefused } from './config.ts'
import { assertAgentLogin, assertRepositoryAccess } from './credentials.ts'
import { Commands } from '../infra/commands.ts'
import { GitHubApi } from '../infra/github-api.ts'
import type { SourceService } from '../sources/host.ts'
import type { SourceKind } from '../sources/kind.ts'
import type { PollTimers } from '../sources/poll.ts'
import type { RepositoryAccess } from '../executor/workspaces.ts'
import { githubSource } from '../sources/github/source.ts'
import { readGithub, repositoryCommands } from '../sources/github/read.ts'
import { githubPullRequests, type PullRequests } from '../sources/github/delivery.ts'

export const GITHUB_TOKEN_ENV = 'SUPERAGENT_CLAUDE_GITHUB_TOKEN'

/**
 * Repository access for git workspaces: remote URLs carry no credentials.
 * The token authenticates only the clone and fetch calls, through an env-scoped header.
 */
export function repositoryAccess(env: Readonly<Record<string, string | undefined>>): RepositoryAccess {
  const token = env[GITHUB_TOKEN_ENV]?.trim()
  const encoded = token ? Buffer.from(`x-access-token:${token}`).toString('base64') : ''
  return {
    remote: repository => `https://github.com/${repository}.git`,
    env: (): Record<string, string> =>
      token
        ? {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}`,
          }
        : {},
    secrets: token ? [token, encoded] : [],
  }
}

export interface InstalledSources {
  kinds: SourceKind[]
  services: SourceService[]
  agentLogin: () => string | undefined
  access: RepositoryAccess
  pulls: PullRequests
  githubRead(repository: string, resource: string, signal?: AbortSignal): Promise<unknown>
}
export interface InstallOptions {
  commands?: Commands
  timers?: PollTimers
  now?: () => number
}

export function installedSources(
  config: Config,
  env: Readonly<Record<string, string | undefined>>,
  options: InstallOptions = {},
): InstalledSources {
  const token = env[GITHUB_TOKEN_ENV]?.trim()
  if (!token) throw new StartupRefused('agent-token', `Startup refused (agent-token): ${GITHUB_TOKEN_ENV} is not set`)
  let login: string | undefined
  const commands = options.commands ?? new Commands({ baseEnv: env, client: new GitHubApi({ token }) })
  const github = githubSource({
    repositories: config.repositories,
    commands,
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.now ? { now: options.now } : {}),
    check: {
      login: (account, error) => {
        if (account === undefined)
          throw new StartupRefused(
            'agent-account',
            `Startup refused (agent-account): could not read the agent account with ${GITHUB_TOKEN_ENV}${error ? ': ' + error : ''}`,
          )
        login = account
        assertAgentLogin(config, account)
      },
      access: accessible => {
        assertRepositoryAccess(config, accessible)
      },
    },
  })
  return {
    kinds: [github.kind],
    services: [github.service],
    agentLogin: () => login,
    access: repositoryAccess(env),
    pulls: githubPullRequests(commands),
    githubRead: (repository, resource, signal) =>
      readGithub(repositoryCommands(commands.withSignal(signal), repository), resource),
  }
}
