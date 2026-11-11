import type { Task } from '../types.ts'
import { StatusBadge } from './StatusBadge.tsx'

export interface TaskRowProps {
  task: Task
}

export function TaskRow({ task }: TaskRowProps) {
  return (
    <li className="task-row">
      <span className="task-title">{task.title}</span>
      <StatusBadge status={task.status} />
      <span className="task-due">{task.dueDate === null ? 'No due date' : 'Due ' + task.dueDate}</span>
    </li>
  )
}
