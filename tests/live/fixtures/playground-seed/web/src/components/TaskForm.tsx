import { useState } from 'react'
import type { FormEvent } from 'react'
import type { NewTask } from '../types.ts'

export interface TaskFormProps {
  onCreate(input: NewTask): Promise<void>
}

export function TaskForm({ onCreate }: TaskFormProps) {
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    try {
      await onCreate({ title: title.trim(), dueDate: dueDate === '' ? null : dueDate })
      setTitle('')
      setDueDate('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form aria-label="New task" onSubmit={handleSubmit}>
      <label>
        Title{' '}
        <input name="title" value={title} onChange={e => setTitle(e.target.value)} />
      </label>
      <label>
        Due date{' '}
        <input type="date" name="dueDate" value={dueDate} onChange={e => setDueDate(e.target.value)} />
      </label>
      <button type="submit" disabled={busy || title.trim() === ''}>
        Add task
      </button>
    </form>
  )
}
