import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { TaskStatus } from '../types.ts'
import { STATUS_LABELS, StatusBadge } from './StatusBadge.tsx'

afterEach(() => cleanup())

describe('StatusBadge', () => {
  it.each<TaskStatus>(['todo', 'doing', 'done'])('shows the label for %s', s => {
    render(<StatusBadge status={s} />)
    const el = screen.getByText(STATUS_LABELS[s])
    expect(el.textContent).toBe(STATUS_LABELS[s])
    expect(el.className).toBe('badge badge-' + s)
  })
})
