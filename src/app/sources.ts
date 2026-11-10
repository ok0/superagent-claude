/** The Source kinds this build installs: the GitHub Source when SUPERAGENT_CLAUDE_GITHUB_TOKEN is set (the token reaches only the gh calls as GH_TOKEN). The single assembly point that names the hosting service outside its Source plugin; a missing or blank token refuses startup (agent-token), and the account and access checks run through the Source startup hook; the token also authenticates the host's clone and fetch calls for git workspaces (env-scoped header, never in worker sessions or git config). */
import { Buffer } from 'node:buffer'
import type { Config } from './config.ts'
import { StartupRefused } from './config.ts'
import { assertAgentLogin, assertRepositoryAccess } from './credentials.ts'
import { Commands } from '../infra/commands.ts'
import type { SourceService } from '../sources/host.ts'
import type { SourceKind } from '../sources/kind.ts'
import type { PollTimers } from '../sources/poll.ts'
import type { RepositoryAccess } from '../executor/workspaces.ts'
import { githubSource } from '../sources/github/source.ts'
import { readGithub, repositoryCommands } from '../sources/github/read.ts'

export const GITHUB_TOKEN_ENV = 'SUPERAGENT_CLAUDE_GITHUB_TOKEN'

/** Repository access for git workspaces: remote URLs without credentials; the token authenticates only the clone and fetch calls through an env-scoped header. Without a token git tries unauthenticated. */
export function repositoryAccess(env: Readonly<Record<string, string | undefined>>): RepositoryAccess {
  const token = env[GITHUB_TOKEN_ENV]?.trim()
  const encoded = token ? Buffer.from(`x-access-token:${token}`).toString('base64') : ''
  return {
    remote: repository => `https://github.com/${repository}.git`,
    env: (): Record<string, string> => token ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}` } : {},
    secrets: token ? [token, encoded] : [],
  }
}

export interface InstalledSources { kinds: SourceKind[]; services: SourceService[]; agentLogin: () => string | undefined; access: RepositoryAccess; githubRead(repository: string, resource: string, signal?: AbortSignal): Promise<unknown> }
export interface InstallOptions { commands?: Commands; timers?: PollTimers; now?: () => number }

export function installedSources(config: Config, env: Readonly<Record<string, string | undefined>>, options: InstallOptions = {}): InstalledSources {
  const token = env[GITHUB_TOKEN_ENV]?.trim()
  if (!token) throw new StartupRefused('agent-token', `Startup refused (agent-token): ${GITHUB_TOKEN_ENV} is not set`)
  let login: string | undefined
  const commands = options.commands ?? new Commands({ apiProgram: 'gh', baseEnv: env, apiEnv: { GH_TOKEN: token, GH_PROMPT_DISABLED: '1' } })
  const github = githubSource({
    repositories: config.repositories,
    commands,
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.now ? { now: options.now } : {}),
    check: {
      login: (account, error) => {
        if (account === undefined) throw new StartupRefused('agent-account', `Startup refused (agent-account): could not read the agent account with ${GITHUB_TOKEN_ENV}${error ? ': ' + error : ''}`)
        login = account
        assertAgentLogin(config, account)
      },
      access: accessible => { assertRepositoryAccess(config, accessible) },
    },
  })
  return { kinds: [github.kind], services: [github.service], agentLogin: () => login, access: repositoryAccess(env), githubRead: (repository, resource, signal) => readGithub(repositoryCommands(commands.withSignal(signal), repository), resource) }
}
