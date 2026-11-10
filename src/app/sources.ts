/** The Source kinds this build installs: the GitHub Source when SUPERAGENT_CLAUDE_GITHUB_TOKEN is set (the token reaches only the gh calls as GH_TOKEN). The single assembly point that names the hosting service outside its Source plugin; a missing or blank token refuses startup (agent-token), and the account and access checks run through the Source startup hook. */
import type { Config } from './config.ts'
import { StartupRefused } from './config.ts'
import { assertAgentLogin, assertRepositoryAccess } from './credentials.ts'
import { Commands } from '../infra/commands.ts'
import type { SourceService } from '../sources/host.ts'
import type { SourceKind } from '../sources/kind.ts'
import type { PollTimers } from '../sources/poll.ts'
import { githubSource } from '../sources/github/source.ts'

export const GITHUB_TOKEN_ENV = 'SUPERAGENT_CLAUDE_GITHUB_TOKEN'

export interface InstalledSources { kinds: SourceKind[]; services: SourceService[]; agentLogin: () => string | undefined }
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
  return { kinds: [github.kind], services: [github.service], agentLogin: () => login }
}
