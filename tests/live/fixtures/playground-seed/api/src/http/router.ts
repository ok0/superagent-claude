import type { IncomingMessage, ServerResponse } from 'node:http'

export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
}

export type Handler = (ctx: RequestContext) => void | Promise<void>

export interface Route {
  method: string
  pattern: string
  handler: Handler
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const expected = pattern.split('/')
  const actual = pathname.split('/')
  if (expected.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i]!
    const got = actual[i]!
    if (want.startsWith(':')) {
      params[want.slice(1)] = decodeURIComponent(got)
    } else if (want !== got) {
      return null
    }
  }
  return params
}

export function matchRoute(
  routes: readonly Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | { allowed: string[] } | null {
  const allowed: string[] = []
  for (const route of routes) {
    const params = matchPattern(route.pattern, pathname)
    if (params === null) continue
    if (route.method === method) return { route, params }
    if (!allowed.includes(route.method)) allowed.push(route.method)
  }
  return allowed.length > 0 ? { allowed } : null
}
