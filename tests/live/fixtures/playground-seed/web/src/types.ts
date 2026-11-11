export type TaskStatus = 'todo' | 'doing' | 'done'
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done']
export type StatusFilterValue = TaskStatus | 'all'
export interface Task {
  id: string
  title: string
  status: TaskStatus
  dueDate: string | null
  ownerId: string
  createdAt: string
  updatedAt: string
}
export interface NewTask {
  title: string
  dueDate: string | null
}
