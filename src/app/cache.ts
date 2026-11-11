// Ported from dsh-superagent-prototype (MIT) src/app/cache.ts
/**
 * In-memory LRU cache bounded by total UTF-16 code units, always retaining the most recently inserted entry.
 * Runtime uses separate instances to cache paginated resource snapshots for `orchestrator_read` and resolved message links for search and cards.
 * Changes from the reference: the constructor parameter is a declared field, assigned in the constructor body.
 */
export class TextCache {
  private readonly texts = new Map<string, string>()
  private readonly limit: number
  private size = 0
  constructor(limit: number) {
    this.limit = limit
  }
  get(key: string): string | undefined {
    const text = this.texts.get(key)
    if (text !== undefined) {
      this.texts.delete(key)
      this.texts.set(key, text)
    }
    return text
  }
  set(key: string, text: string): void {
    this.size -= this.texts.get(key)?.length ?? 0
    this.texts.delete(key)
    this.texts.set(key, text)
    this.size += text.length
    for (const [oldest, value] of this.texts) {
      if (this.size <= this.limit || oldest === key) break
      this.texts.delete(oldest)
      this.size -= value.length
    }
  }
  /** Entries ordered from least to most recently used. */
  entries(): IterableIterator<[string, string]> {
    return this.texts.entries()
  }
}
