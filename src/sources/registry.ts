// Ported from dsh-superagent-prototype (MIT) src/sources/registry.ts
/** Registry of installed Source kinds and their configured instances, and the Engine's SourceScope. Changes from the reference: instance configs come from an injected reader instead of stored settings, and an instance is enabled while its config parses; per-kind policy parts, instance listing, variable declarations and links are removed; each kind reports under the health entry named after it, and `<kind>:<entry>` entries are claimed on first report; sending takes no command runner; `enabled` is added for the Outbox; constructor parameters are declared fields. */
import type { OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import { HealthBoard, type Health, type HealthEntry } from '../infra/health.ts'
import type { SourceInstance, SourceKind, TriggerContext } from './kind.ts'

export type HealthReporter = (health: Health, entry?: string) => void

interface Registration {
  kind: SourceKind
  entries: Map<string, HealthEntry>
  live: boolean
}

export class SourceRegistry implements SourceScope {
  private readonly registrations = new Map<string, Registration>()
  private readonly configs: () => Readonly<Record<string, unknown>>
  private readonly board: Pick<HealthBoard, 'claim'>

  constructor(configs: () => Readonly<Record<string, unknown>> = () => ({}), board: Pick<HealthBoard, 'claim'> = new HealthBoard()) {
    this.configs = configs
    this.board = board
  }

  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.registrations.has(kind.kind)) throw new Error('Source kind already registered: ' + kind.kind)
    let entry: HealthEntry
    try {
      entry = this.board.claim(kind.kind, { state: 'starting', detail: '' })
    } catch {
      throw new Error(`Source kind ${kind.kind} declares the health entry ${kind.kind}, which another part reports`)
    }
    const registration: Registration = { kind: kind as unknown as SourceKind, entries: new Map([[kind.kind, entry]]), live: true }
    this.registrations.set(kind.kind, registration)
    return () => {
      if (this.registrations.get(kind.kind) === registration) this.registrations.delete(kind.kind)
      registration.live = false
      for (const held of registration.entries.values()) held.release()
    }
  }

  reporter(id: string): HealthReporter {
    const registration = this.registrations.get(id)
    if (!registration) throw new Error('Source kind not registered: ' + id)
    return (health, entry) => {
      if (!registration.live) return
      const name = entry ? `${id}:${entry}` : id
      let held = registration.entries.get(name)
      if (!held) {
        held = this.board.claim(name)
        registration.entries.set(name, held)
      }
      held.set(health)
    }
  }

  kind(id: string): SourceKind | undefined {
    return this.registrations.get(id)?.kind
  }

  kinds(): SourceKind[] {
    return [...this.registrations.values()].map(registration => registration.kind).sort((a, b) => a.kind.localeCompare(b.kind))
  }

  instance<C extends Record<string, unknown>>(id: string): SourceInstance<C> | undefined {
    const kind = this.kind(id)
    return kind ? this.resolve(kind) as SourceInstance<C> : undefined
  }

  enabled(source: string): boolean {
    return this.instance(source)?.enabled ?? false
  }

  validate(id: string, config: unknown): Record<string, unknown> {
    const kind = this.kind(id)
    if (!kind) throw new Error('Source kind not installed: ' + id)
    return kind.schema.parse(config)
  }

  channelAllowed(channel: { source: string; address: Record<string, string> }): boolean {
    const kind = this.kind(channel.source)
    if (!kind) return false
    const instance = this.resolve(kind)
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }

  environments(): { kind: string; values: (input: { trigger?: Trigger }) => Record<string, string> }[] {
    return this.kinds().flatMap(kind => {
      const environment = kind.environment
      const instance = this.resolve(kind)
      return environment && instance.enabled ? [{ kind: kind.kind, values: (input: { trigger?: Trigger }) => environment.values({ config: instance.config, ...input }) }] : []
    })
  }

  async send(message: OutboundMessage): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kind(message.channel.source)
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send(message) : 'gone'
  }

  find(query: string): { threads: string[]; terms: string[] } {
    const found = this.kinds().flatMap(kind => kind.find ? [kind.find(query)] : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }

  repliesTo(trigger: Trigger): string | undefined {
    return this.kind(trigger.source)?.repliesTo?.(trigger)
  }

  threadContext(trigger: Trigger): TriggerContext | undefined {
    const kind = this.kind(trigger.source)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const { config } = this.resolve(kind)
    return {
      messageId: context.messageId(trigger),
      read: (part, cursor) => context.read(trigger, part, cursor, config),
    }
  }

  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    const kind = this.kind(input.source)
    const stored = this.configs()[input.source]
    if (!kind) return stored !== undefined ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.resolve(kind)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope?.({ meta: input.meta }, instance.config) ?? { listened: true, observed: false }
  }

  private resolve(kind: SourceKind): SourceInstance {
    const parsed = kind.schema.safeParse(this.configs()[kind.kind] ?? {})
    return { id: kind.kind, kind: kind.kind, enabled: parsed.success, config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
