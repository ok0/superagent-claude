/** Exposes the host ToolSpecs as an in-process SDK MCP server named `issuecrew`, so names and validation match. */
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ToolSpec } from '../../executor/contract.ts'

export const MCP_SERVER = 'issuecrew'
export const mcpToolName = (name: string): string => `mcp__${MCP_SERVER}__${name}`

export type ToolCallResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export function toolHandler(spec: ToolSpec, signal: AbortSignal): (args: unknown) => Promise<ToolCallResult> {
  return async (args: unknown) => {
    try {
      const value = await spec.execute(args, signal)
      return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }] }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              error instanceof z.ZodError
                ? z.prettifyError(error)
                : error instanceof Error
                  ? error.message
                  : String(error),
          },
        ],
      }
    }
  }
}

export function mcpTools(tools: readonly ToolSpec[], signal: AbortSignal): SdkMcpToolDefinition[] {
  return tools.map(
    t =>
      tool(
        t.name,
        t.description,
        t.schema.shape as never,
        toolHandler(t, signal) as never,
      ) as unknown as SdkMcpToolDefinition,
  )
}

export function mcpServer(tools: readonly ToolSpec[], signal: AbortSignal): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: MCP_SERVER, version: '1.0.0', tools: mcpTools(tools, signal) })
}
