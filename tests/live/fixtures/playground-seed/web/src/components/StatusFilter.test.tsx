import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StatusFilter } from './StatusFilter.tsx'

const user = userEvent.setup()

afterEach(() => cleanup())

describe('StatusFilter', () => {
  it('lists all statuses', () => {
    render(<StatusFilter value="all" onChange={vi.fn()} />)
    const select = screen.getByLabelText(/^Show/) as HTMLSelectElement
    expect(Array.from(select.options).map(o => o.value)).toEqual(['all', 'todo', 'doing', 'done'])
  })

  it('reports the chosen status', async () => {
    const onChange = vi.fn()
    render(<StatusFilter value="all" onChange={onChange} />)
    await user.selectOptions(screen.getByLabelText(/^Show/), 'done')
    expect(onChange).toHaveBeenCalledWith('done')
  })
})
