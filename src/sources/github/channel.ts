// Ported from dsh-superagent-prototype (MIT) src/sources/github-channel.ts
/** GitHub outbound channel: posts issue/PR comments and review thread replies under the agent account. Changes from the reference: the reply goes to the repository named in the address, which must be configured; the commands and the agent login are injected; the retry marker is <!-- superagent-claude:<id> -->; the channel link is removed. */
import { z } from 'zod'
import type { OutboundMessage } from '../../core/index.ts'
import { CliError, type Commands } from '../../infra/commands.ts'
import { sameName } from '../../policy/actors.ts'
import type { SourceChannel } from '../kind.ts'
import { repositoryCommands } from './read.ts'
import { configured, githubAddress, type GithubConfig } from './trigger.ts'

const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), in_reply_to_id: z.number().nullish(), user: z.looseObject({ login: z.string() }).nullish(),
})
/** True when an issue is permanently deleted (410) or locked (403); 404 is retried because it can indicate temporary permission loss on a private repo. */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))
const missing = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
export const MARKER = (id: string): string => `<!-- superagent-claude:${id} -->`

export interface ChannelOptions { commands: Commands; repositories: readonly string[]; login(): string | undefined }

/** Posts a comment or review-thread reply with an embedded HTML marker so retries do not create duplicate comments. */
export function githubChannelAdapter(options: ChannelOptions): SourceChannel<GithubConfig> {
  return {
    allowed: address => !!configured(options.repositories, address.repository ?? '') && Number(address.number) > 0,
    send: async (message: OutboundMessage) => {
      const address = message.channel.address
      const repository = configured(options.repositories, address.repository ?? '')
      if (!repository) return 'gone'
      const number = Number(address.number)
      if (!number) throw new Error('Missing GitHub reply target')
      const login = options.login()
      if (!login) throw new Error('The agent account is not known yet')
      const commands = repositoryCommands(options.commands, repository)
      try {
        // Retained trigger URLs also route replies queued before thread-aware delivery.
        const target = githubAddress(address.url ?? '', [repository])
        let rootId: number | undefined
        if (target?.pr && target.discussion && target.number === number) {
          // Fall back to a top-level PR comment if the target inline review comment was deleted.
          const source = await commands.api(CommentSchema, `pulls/comments/${target.discussion}`)
            .catch((error: unknown) => { if (missing(error)) return undefined; throw error })
          rootId = source ? source.in_reply_to_id ?? source.id : undefined
        }
        const path = rootId === undefined ? `issues/${number}/comments` : `pulls/${number}/comments`
        const marker = MARKER(message.id)
        const mine = (comment: z.infer<typeof CommentSchema>) => sameName(comment.user?.login ?? '', login)
          && (rootId === undefined || comment.in_reply_to_id === rootId) && (comment.body ?? '').includes(marker)
        if ((await commands.pages(CommentSchema, path)).some(mine)) return 'sent'
        const post = rootId === undefined ? path : `${path}/${rootId}/replies`
        await commands.api(z.unknown(), post, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
        return 'sent'
      } catch (error) {
        if (gone(error)) return 'gone'
        throw error
      }
    },
  }
}
