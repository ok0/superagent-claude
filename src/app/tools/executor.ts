// Ported from dsh-superagent-prototype (MIT) src/app/tools/executor.ts
/**
 * Worker Session tools for acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status.
 * Changes from the reference: `orchestrator_read` is restored (M14) over the injected reader; `pr_number` and the PR claim
 * (M16, `orchestrator_publish`) and `sendReplies` are removed; a GitHub thread must name a configured repository; a followed
 * thread is announced to the Router session through `notify` (M14); the report relay is the Runtime's (M14).
 */
import { z } from 'zod'
import { type EngineForExecutor, type WorkerReport } from '../../core/index.ts'
import { liveTicket, type Ticket } from '../../core/model.ts'
import type { ToolSpec } from '../../executor/contract.ts'
import { parseThreadId, configured } from '../../sources/github/trigger.ts'
import { resourceGrammar } from '../resources.ts'
import { threadFollowedNotice, type Notice } from '../notices.ts'
import { AcknowledgementSchema, HumanActionSchema, readTool, tool } from './tool.ts'

export interface ExecutorToolsHost {
  engine(): Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  ticket(id: string): Pick<Ticket, 'ended'> | undefined
  read?(resource: string, offset: number, limit: number | undefined, signal: AbortSignal): Promise<unknown>
  /** Announces a change to the Router session; present when the Router session runs. */
  notify?(notice: Notice): void
  repositories?(): readonly string[]
}

export function executorTools(host: ExecutorToolsHost, ticket: Pick<Ticket, 'id'>): ToolSpec[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      resourceGrammar(true), (resource, offset, limit, signal) => host.read
        ? host.read(resource, offset, limit, signal) : Promise.reject(new Error('No resources are available in this session'))),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema,
      }).strict(),
      execute: async args => {
        const reply = host.engine().reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        return { trigger_id: args.trigger_id, acknowledgement: reply.status, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as <source>:<id>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => {
        host.engine().markUnrelated(ticketId, args.thread, args.reason)
        return { removed: true, thread: args.thread }
      },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, as trigger/<id> shows it, such as <source>:<id>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, as trigger/<id> shows it')
        const source = args.thread.slice(0, at)
        const id = args.thread.slice(at + 1)
        if (source === 'github' && host.repositories) {
          const parsed = parseThreadId(id)
          if (!parsed) throw new Error('A GitHub thread key is github:<owner>/<name>#<number>')
          if (!configured(host.repositories(), parsed.repository)) throw new Error(`Repository ${parsed.repository} is not in the configured repositories`)
        }
        const followed = host.engine().followForContext(ticketId, { source, id })
        if (followed && host.notify) host.notify(threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      },
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine().handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: HumanActionSchema.nullish().describe('One concrete question for a person in one sentence of at most 100 words, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async args => {
        const current = host.ticket(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const report: WorkerReport = {
          state: args.state,
          summary: args.summary,
          ...(args.human_action !== undefined ? { question: args.human_action } : {}),
          ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
          ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}),
        }
        const updated = host.engine().report(ticketId, report)
        return { reported: true, ...(updated.attention ? { attention: updated.attention } : {}) }
      },
    }),
  ]
}
