import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TaskForm } from './TaskForm.tsx'

const user = userEvent.setup()

afterEach(() => cleanup())

describe('TaskForm', () => {
  it('submit is disabled until a title is typed', async () => {
    render(<TaskForm onCreate={vi.fn(async () => {})} />)
    const submit = screen.getByRole('button', { name: 'Add task' }) as HTMLButtonElement
    const title = screen.getByLabelText('Title')
    expect(submit.disabled).toBe(true)
    await user.type(title, '   ')
    expect(submit.disabled).toBe(true)
    await user.type(title, 'Write docs')
    expect(submit.disabled).toBe(false)
  })

  it('creates a task with a due date', async () => {
    const onCreate = vi.fn(async () => {})
    render(<TaskForm onCreate={onCreate} />)
    const title = screen.getByLabelText('Title') as HTMLInputElement
    const due = screen.getByLabelText('Due date') as HTMLInputElement
    await user.type(title, 'Write docs')
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2999-12-31' } })
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith({ title: 'Write docs', dueDate: '2999-12-31' })
    await vi.waitFor(() => expect(title.value).toBe(''))
    expect(due.value).toBe('')
  })

  it('creates a task without a due date', async () => {
    const onCreate = vi.fn(async () => {})
    render(<TaskForm onCreate={onCreate} />)
    await user.type(screen.getByLabelText('Title'), '  Plan  ')
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    expect(onCreate).toHaveBeenCalledWith({ title: 'Plan', dueDate: null })
  })
})
