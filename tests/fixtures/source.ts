/** A scripted Source kind for runtime tests: its Channel records what it sends, and its service hands Triggers to the Engine through the SourceHost. */
import { z } from 'zod'
import type { OutboundMessage, ReceiveResult, Trigger } from '../../src/core/index.ts'
import type { SourceHost, SourceService } from '../../src/sources/host.ts'
import type { SourceKind } from '../../src/sources/kind.ts'

export function testSource(kind = 'chat', extra: Partial<SourceKind> = {}) {
  const sent: OutboundMessage[] = []
  let stops = 0
  let current: SourceHost | undefined
  const source: SourceKind = {
    kind,
    schema: z.record(z.string(), z.unknown()),
    channel: {
      send: async message => {
        sent.push(message)
        return 'sent'
      },
    },
    ...extra,
  }
  const service: SourceService = {
    kind,
    start: async host => {
      current = host
    },
    stop: async () => {
      stops++
      current = undefined
    },
  }
  return {
    kind: source,
    service,
    sent,
    stops: (): number => stops,
    emit(trigger: Trigger): ReceiveResult {
      if (!current) throw new Error('The test Source is not running')
      return current.context(kind).receive(trigger)
    },
  }
}
