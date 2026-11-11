import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AUTH_A = { authorization: 'Bearer tok-a' }
export const AUTH_B = { authorization: 'Bearer tok-b' }

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

export async function startApi(): Promise<{ base: string; stop(): Promise<void> }> {
  const port = await freePort()
  const api = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: api,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PORT: String(port),
      API_TOKENS: 'alice:tok-a,bob:tok-b',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const base = 'http://127.0.0.1:' + port
  const deadline = Date.now() + 15000
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('api exited: ' + stderr)
    try {
      const res = await fetch(base + '/health')
      await res.text()
      if (res.status === 200) break
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGTERM')
      throw new Error('api did not start')
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return {
    base,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await once(child, 'exit')
      }
    },
  }
}
