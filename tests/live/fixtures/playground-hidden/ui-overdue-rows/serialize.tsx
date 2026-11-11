import { cleanup, render, screen } from '@testing-library/react'
import type { TaskClient } from '../api/client.ts'
import type { Task } from '../types.ts'
import { App } from '../components/App.tsx'
import { ErrorBanner } from '../components/ErrorBanner.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { TaskList } from '../components/TaskList.tsx'

const base = { ownerId: 'alice', createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z' }

export const TASKS: readonly Task[] = [
  { id: 'task-1', title: 'Pay the invoice', status: 'todo', dueDate: '2000-01-01', ...base },
  { id: 'task-2', title: 'Plan the trip', status: 'doing', dueDate: '2999-12-31', ...base },
  { id: 'task-3', title: 'Read a book', status: 'todo', dueDate: null, ...base },
  { id: 'task-4', title: 'Water the plants', status: 'done', dueDate: '2999-12-31', ...base },
]

export const ROW_TITLES = { overdue: 'Pay the invoice', future: 'Plan the trip', none: 'Read a book', doneFuture: 'Water the plants' } as const

export interface BaseDom {
  rows: Record<keyof typeof ROW_TITLES, string | null>
  components: { heading: string | null; form: string | null; filter: string | null; errorBanner: string; emptyList: string; statusBadge: { todo: string; doing: string; done: string } }
}

const rowOf = (title: string): string | null => {
  const row = screen.getAllByRole('listitem').find(li => (li.textContent ?? '').includes(title))
  return row ? row.outerHTML : null
}

export async function serialize(): Promise<BaseDom> {
  const client: TaskClient = {
    listTasks: async () => [...TASKS],
    createTask: async () => {
      throw new Error('not used')
    },
  }
  render(<App client={client} />)
  await screen.findAllByRole('listitem')
  const rows = {
    overdue: rowOf(ROW_TITLES.overdue),
    future: rowOf(ROW_TITLES.future),
    none: rowOf(ROW_TITLES.none),
    doneFuture: rowOf(ROW_TITLES.doneFuture),
  }
  const heading = document.querySelector('h1')?.outerHTML ?? null
  const form = document.querySelector('form[aria-label="New task"]')?.outerHTML ?? null
  const filter = document.querySelector('.status-filter')?.outerHTML ?? null
  cleanup()
  const errorBanner = render(<ErrorBanner message="Request failed" />).container.innerHTML
  cleanup()
  const emptyList = render(<TaskList tasks={[]} />).container.innerHTML
  cleanup()
  const statusBadge = { todo: '', doing: '', done: '' }
  for (const status of ['todo', 'doing', 'done'] as const) {
    statusBadge[status] = render(<StatusBadge status={status} />).container.innerHTML
    cleanup()
  }
  return { rows, components: { heading, form, filter, errorBanner, emptyList, statusBadge } }
}
