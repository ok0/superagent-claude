/**
 * Read-only git for the ticket's worktree: diff, log, show or blame. The output is external data,
 * so it is wrapped as such before it reaches the model.
 */
import { z } from 'zod'
import type { ToolSpec } from '../../executor/contract.ts'
import type { GitInspectRequest } from '../../executor/git-inspect.ts'
import { wrapExternal } from '../prompts.ts'
import { tool } from './tool.ts'

export function inspectTool(
  host: { inspect?(ticketId: string, request: GitInspectRequest): Promise<string> },
  ticketId: string,
): ToolSpec {
  return tool({
    name: 'git_inspect',
    description:
      "Read-only git for this ticket's worktree: diff, log, show or blame. rev is one revision or a range a..b or a...b (diff and log only); path is a repository-relative file or directory (required for blame); limit is commits for log (20 by default, 100 at most) or output lines otherwise (400 by default, 2000 at most). No other options are accepted; long output is truncated.",
    schema: z
      .object({
        command: z.enum(['diff', 'log', 'show', 'blame']).describe('The git command to run.'),
        rev: z.string().max(405).optional().describe('One revision, or a range a..b or a...b for diff and log only.'),
        path: z.string().max(500).optional().describe('A repository-relative file or directory; required for blame.'),
        limit: z
          .number()
          .int()
          .optional()
          .describe('Commits for log (1 to 100, default 20); output lines otherwise (1 to 2000, default 400).'),
      })
      .strict(),
    execute: async args => {
      if (!host.inspect) throw new Error('This session has no git worktree')
      const request: GitInspectRequest = { command: args.command }
      if (args.rev !== undefined) request.rev = args.rev
      if (args.path !== undefined) request.path = args.path
      if (args.limit !== undefined) request.limit = args.limit
      return wrapExternal({ source: 'git-inspect', text: await host.inspect(ticketId, request) })
    },
  })
}
