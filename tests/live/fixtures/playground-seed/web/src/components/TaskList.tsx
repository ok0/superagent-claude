import type { Task } from '../types.ts'
import { TaskRow } from './TaskRow.tsx'

export interface TaskListProps {
  tasks: readonly Task[]
}

export function TaskList({ tasks }: TaskListProps) {
  if (tasks.length === 0) {
    return <p className="empty">No tasks</p>
  }
  return (
    <ul className="task-list" aria-label="Tasks">
      {tasks.map(t => (
        <TaskRow key={t.id} task={t} />
      ))}
    </ul>
  )
}
