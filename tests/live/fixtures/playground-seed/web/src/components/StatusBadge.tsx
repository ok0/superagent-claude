import type { TaskStatus } from '../types.ts'

export const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  todo: 'To do',
  doing: 'In progress',
  done: 'Done',
}

export interface StatusBadgeProps {
  status: TaskStatus
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={'badge badge-' + status}>{STATUS_LABELS[status]}</span>
}
