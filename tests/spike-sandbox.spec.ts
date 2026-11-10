/** Status rules of the sandbox spike item: PASS, BLOCKED when the sandbox or the network is not usable, FAIL only when a live sandbox lets the disallowed domain through. */
import { describe, expect, it } from 'vitest'
import { networkStatus, staticSandboxAvailable } from '../spikes/sdk/items/r19-sandbox-secrets.ts'

const OK = ['200', '200']

describe('sandbox spike status', () => {
  it.each([
    {
      name: 'allowed reached, other blocked',
      input: { sandbox: ['200', '000'], control: OK, staticAvailable: true, sandboxLive: true },
      expected: { status: 'PASS' },
    },
    {
      name: 'no sandbox binaries',
      input: { sandbox: [], control: OK, staticAvailable: false, sandboxLive: false },
      expected: { status: 'BLOCKED', reason: 'sandbox-unavailable' },
    },
    {
      name: 'sandbox not live',
      input: { sandbox: ['200', '200'], control: OK, staticAvailable: true, sandboxLive: false },
      expected: { status: 'BLOCKED', reason: 'sandbox-unavailable' },
    },
    {
      name: 'everything blocked inside a live sandbox',
      input: { sandbox: ['000', '000'], control: OK, staticAvailable: true, sandboxLive: true },
      expected: { status: 'BLOCKED', reason: 'sandbox-unavailable' },
    },
    {
      name: 'no network at all',
      input: { sandbox: ['000', '000'], control: ['000', '000'], staticAvailable: true, sandboxLive: true },
      expected: { status: 'BLOCKED', reason: 'no-network' },
    },
    {
      name: 'live sandbox lets the other domain through',
      input: { sandbox: ['200', '200'], control: OK, staticAvailable: true, sandboxLive: true },
      expected: { status: 'FAIL' },
    },
  ])('$name', ({ input, expected }) => {
    expect(networkStatus(input)).toEqual(expected)
  })

  it('static availability is false on other platforms', () => {
    expect(staticSandboxAvailable('win32')).toBe(false)
  })
})
