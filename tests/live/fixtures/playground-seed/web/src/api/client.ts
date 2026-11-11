import type { NewTask, Task } from '../types.ts'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export interface TaskClient {
  listTasks(): Promise<Task[]>
  createTask(input: NewTask): Promise<Task>
}

export function createTaskClient(o: { baseUrl: string; token: string; fetch?: FetchLike }): TaskClient {
  const send: FetchLike = o.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const headers = { authorization: 'Bearer ' + o.token }

  async function fail(res: Pick<Response, 'status' | 'json'>): Promise<never> {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      throw new ApiError(res.status, error.code, error.message)
    }
    throw new ApiError(res.status, 'http_error', 'request failed with status ' + res.status)
  }

  return {
    async listTasks() {
      const res = await send(o.baseUrl + '/tasks?limit=100', { headers })
      if (!res.ok) return fail(res)
      return ((await res.json()) as { items: Task[] }).items
    },
    async createTask(input) {
      const res = await send(o.baseUrl + '/tasks', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!res.ok) return fail(res)
      return (await res.json()) as Task
    },
  }
}
