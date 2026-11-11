export class LineBuffer {
  private readonly sink: (chunk: string) => void
  private readonly capacity: number
  private readonly store: Buffer
  private used: number

  constructor(sink: (chunk: string) => void, capacity = 4096) {
    this.sink = sink
    this.capacity = capacity
    this.store = Buffer.alloc(capacity)
    this.used = 0
  }

  write(line: string): void {
    const bytes = Buffer.from(line + '\n', 'utf8')
    if (bytes.length > this.capacity) {
      this.flush()
      this.sink(bytes.toString('utf8'))
      return
    }
    if (this.used + bytes.length > this.capacity) this.flush()
    bytes.copy(this.store, this.used)
    this.used += bytes.length
  }

  flush(): void {
    if (this.used === 0) return
    this.sink(this.store.toString('utf8', 0, this.used))
    this.used = 0
  }
}
