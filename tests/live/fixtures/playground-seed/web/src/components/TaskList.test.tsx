import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { Task } from '../types.ts'
import { TaskList } from './TaskList.tsx'

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

afterEach(() => cleanup())

describe('TaskList', () => {
  it('shows an empty state', () => {
    render(<TaskList tasks={[]} />)
    expect(screen.getByText('No tasks')).toBeTruthy()
  })

  it('renders rows in order', () => {
    render(
      <TaskList tasks={[task('task-1', { title: 'First' }), task('task-2', { title: 'Second' }), task('task-3', { title: 'Third' })]} />,
    )
    const titles = within(screen.getByRole('list', { name: 'Tasks' }))
      .getAllByRole('listitem')
      .map(li => li.querySelector('.task-title')?.textContent)
    expect(titles).toEqual(['First', 'Second', 'Third'])
  })

  describe.each(['2001-06-01T00:30:00Z', '2026-11-11T12:00:00Z', '2099-12-31T23:30:00Z'])('with the clock at %s', now => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(now))
    })

    afterEach(() => vi.useRealTimers())

    it('an overdue task row has the same DOM as a task that is not due', () => {
      render(
        <TaskList
          tasks={[
            task('task-1', { title: 'Same', dueDate: '2000-01-01' }),
            task('task-2', { title: 'Same', dueDate: '2999-12-31' }),
          ]}
        />,
      )
      const rows = screen.getAllByRole('listitem')
      expect(rows[0].outerHTML.replace('2000-01-01', 'DATE')).toBe(rows[1].outerHTML.replace('2999-12-31', 'DATE'))
      expect(rows[0].className).toBe(rows[1].className)
      expect(rows[0].getAttributeNames()).toEqual(rows[1].getAttributeNames())
    })
  })
})
