export function now(): Date {
  const raw = process.env.FAKE_NOW
  if (raw !== undefined) {
    const pinned = new Date(raw)
    if (!Number.isNaN(pinned.getTime())) return pinned
  }
  return new Date()
}
