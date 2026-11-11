import { useEffect, useState } from 'react'
import type { TaskClient } from '../api/client.ts'
import type { NewTask, StatusFilterValue, Task } from '../types.ts'
import { ErrorBanner } from './ErrorBanner.tsx'
import { StatusFilter } from './StatusFilter.tsx'
import { TaskForm } from './TaskForm.tsx'
import { TaskList } from './TaskList.tsx'

export interface AppProps {
  client: TaskClient
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'request failed'
}

export function App({ client }: AppProps) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [filter, setFilter] = useState<StatusFilterValue>('all')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    client
      .listTasks()
      .then(
        items => {
          if (active) setTasks(items)
        },
        e => {
          if (active) setError(messageOf(e))
        },
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [client])

  async function create(input: NewTask) {
    try {
      const task = await client.createTask(input)
      setTasks(prev => [...prev, task])
      setError(null)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <main>
      <h1>Tasks</h1>
      <ErrorBanner message={error} />
      <TaskForm onCreate={create} />
      <StatusFilter value={filter} onChange={setFilter} />
      {loading ? (
        <p>Loading…</p>
      ) : (
        <TaskList tasks={filter === 'all' ? tasks : tasks.filter(t => t.status === filter)} />
      )}
    </main>
  )
}
