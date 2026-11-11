import { TASK_STATUSES } from '../types.ts'
import type { StatusFilterValue } from '../types.ts'
import { STATUS_LABELS } from './StatusBadge.tsx'

export interface StatusFilterProps {
  value: StatusFilterValue
  onChange(value: StatusFilterValue): void
}

export function StatusFilter({ value, onChange }: StatusFilterProps) {
  return (
    <label className="status-filter">
      Show{' '}
      <select value={value} onChange={e => onChange(e.target.value as StatusFilterValue)}>
        <option value="all">All</option>
        {TASK_STATUSES.map(s => (
          <option key={s} value={s}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
    </label>
  )
}
