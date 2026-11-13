/** Default vitest setup: offline tests may fetch only loopback hosts; a test fake for api.github.com is installed on top and passes other hosts back here. */
const original = globalThis.fetch.bind(globalThis)

export const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '[::1]' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)

export const guardedFetch: typeof globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!isLoopback(url.hostname)) throw new TypeError(`network guard: offline tests may not reach ${url.host}`)
  return original(input, init)
}

globalThis.fetch = guardedFetch
