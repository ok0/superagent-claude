import type { Task } from '../types.ts'
import { StatusBadge } from './StatusBadge.tsx'

export interface TaskRowProps {
  task: Task
}

const key = (date: Date): string => {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isOverdue(task: Task, today: Date = new Date()): boolean {
  return task.status !== 'done' && task.dueDate !== null && task.dueDate < key(today)
}

export function TaskRow({ task }: TaskRowProps) {
  return (
    <li className={isOverdue(task) ? 'task-row task-row-overdue' : 'task-row'}>
      <span className="task-title">{task.title}</span>
      <StatusBadge status={task.status} />
      <span className="task-due">{task.dueDate === null ? 'No due date' : 'Due ' + task.dueDate}</span>
    </li>
  )
}
