import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTaskClient } from '../api/client.ts'
import type { FetchLike } from '../api/client.ts'
import type { Task } from '../types.ts'
import { App } from './App.tsx'

const user = userEvent.setup()

const fetchMock = vi.fn<FetchLike>()

const client = createTaskClient({ baseUrl: 'http://api.test', token: 'tok-a', fetch: fetchMock })

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: 'Task ' + id,
  status: 'todo',
  dueDate: null,
  ownerId: 'alice',
  createdAt: '2000-01-01T00:00:00.000Z',
  updatedAt: '2000-01-01T00:00:00.000Z',
  ...over,
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
})

describe('App', () => {
  it('loads and lists tasks', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, {
        items: [task('task-1', { title: 'Write docs' }), task('task-2', { title: 'Ship', status: 'done' })],
        nextCursor: null,
      }),
    )
    render(<App client={client} />)
    await screen.findByText('Write docs')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://api.test/tasks?limit=100')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-a')
  })

  it('filters by status', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, {
        items: [task('task-1', { title: 'Write docs' }), task('task-2', { title: 'Ship', status: 'done' })],
        nextCursor: null,
      }),
    )
    render(<App client={client} />)
    await screen.findByText('Write docs')
    await user.selectOptions(screen.getByLabelText(/^Show/), 'done')
    expect(screen.getByText('Ship')).toBeTruthy()
    expect(screen.queryByText('Write docs')).toBeNull()
  })

  it('creates a task', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, { items: [], nextCursor: null }))
      .mockResolvedValueOnce(reply(201, task('task-9', { title: 'New one' })))
    render(<App client={client} />)
    await screen.findByText('No tasks')
    await user.type(screen.getByLabelText('Title'), 'New one')
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    await screen.findByText('New one')
    const [, init] = fetchMock.mock.calls[1]
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ title: 'New one', dueDate: null })
  })

  it('shows API errors', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(401, { error: { code: 'unauthorized', message: 'invalid or missing token' } }),
    )
    render(<App client={client} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('invalid or missing token')
  })
})
