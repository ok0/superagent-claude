import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'

describe('network guard', () => {
  it('rejects fetch to a non-loopback host', async () => {
    await expect(fetch('https://example.com')).rejects.toThrow(/network guard/)
    await expect(fetch('https://api.github.com/user')).rejects.toThrow(/network guard/)
  })

  it('allows fetch to 127.0.0.1', async () => {
    const server = createServer((_req, res) => {
      res.end('ok')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const res = await fetch(`http://127.0.0.1:${port}/`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('ok')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('is installed by the default config only', () => {
    const base = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8')
    const live = readFileSync(new URL('../vitest.live.config.ts', import.meta.url), 'utf8')
    expect(base).toContain('tests/fixtures/network-guard.ts')
    expect(live).not.toContain('network-guard')
  })
})
