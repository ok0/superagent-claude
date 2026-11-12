// Ported from dsh-superagent-prototype (MIT) src/app/tools/tool.ts
import { z } from 'zod'
import type { ToolSpec } from '../../executor/contract.ts'
import { wordCount } from '../../infra/text.ts'

export const HUMAN_WORDS = 100

export function tool<S extends z.ZodObject>(definition: {
  name: string
  description: string
  schema: S
  execute(args: z.infer<S>, signal: AbortSignal): Promise<unknown>
}): ToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
    execute: async (args, signal) => definition.execute(definition.schema.parse(args), signal),
  }
}

export function humanTextProblem(text: string): string | undefined {
  if (/[\n\r]/.test(text)) return 'Write it on one line.'
  const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].filter(segment =>
    /\S/.test(segment.segment),
  )
  if (sentences.length > 1) return 'Write exactly one sentence.'
  if ((text.match(/[?？]/g) ?? []).length > 1) return 'Ask exactly one question.'
  if (wordCount(text) > HUMAN_WORDS) return `Use at most ${HUMAN_WORDS} words.`
  return undefined
}

export const AcknowledgementSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    text => wordCount(text) <= HUMAN_WORDS,
    `An acknowledgement has at most ${HUMAN_WORDS} words; write one short sentence.`,
  )

export const HumanActionSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .superRefine((text, ctx) => {
    const problem = humanTextProblem(text)
    if (problem)
      ctx.addIssue({ code: 'custom', message: `human_action must be one concrete question for a person: ${problem}` })
  })

/** The `orchestrator_read` tool: one page of a resource that the grammar lists, read through `read`. */
export function readTool(
  description: string,
  grammar: string,
  read: (resource: string, offset: number, limit: number | undefined, signal: AbortSignal) => Promise<unknown>,
): ToolSpec {
  return tool({
    name: 'orchestrator_read',
    description,
    schema: z
      .object({
        resource: z.string().min(1).describe(`The resource, one of: ${grammar}.`),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Copy next_offset from the previous page; it counts characters of a text and items of a list.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(8000)
          .optional()
          .describe(
            'Characters of a text, 4000 by default and 8000 at most, or items of a list, 20 by default and 50 at most.',
          ),
      })
      .strict(),
    execute: async (args, signal) => read(args.resource, args.offset, args.limit, signal),
  })
}
