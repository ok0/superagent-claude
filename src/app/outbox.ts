// Ported from dsh-superagent-prototype (MIT) src/app/outbox.ts
/**
 * Reliable outbound message delivery backed by persistent receipts and retried reply effects.
 * Changes from the reference: the Outbox depends on the local `OutboxChannels` port instead of `SourceRegistry` and `Commands`; the IM length check is dropped; the constructor parameter is a declared field.
 */
import type { ChannelRef } from '../core/index.ts'
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'

/** `waiting`: the Source cannot send yet (retried later); `gone`: the conversation can never receive it. */
export type SendResult = 'sent' | 'gone' | 'waiting'
/** Channel delivery the Outbox needs from the Sources (bound to the SourceRegistry by the Runtime). */
export interface OutboxChannels {
  enabled(source: string): boolean
  allowed(channel: ChannelRef): boolean
  send(message: OutboundMessage): Promise<SendResult>
}

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly channels: OutboxChannels
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and the `OutboxChannels` port.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  private readonly host: OutboxHost
  constructor(host: OutboxHost) {
    this.host = host
    host.effects.handle('reply', (_payload, id) => this.deliver(id), {
      limit: () => (this.host.paused() ? 0 : 1),
      retry: [5000, 300_000],
    })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    const { store, effects } = this.host
    store.atomic(() => {
      if (store.receipts.add(message)) effects.enqueue('reply', message.id, {})
    })
  }
  status(id: string): ReplyStatus | undefined {
    return this.host.store.receipts.get(id)?.status
  }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => {
      if (store.receipts.withdraw(id)) effects.cancel('reply', id)
    })
  }
  sent(): Promise<void> {
    return this.host.effects.idle('reply')
  }
  /** Reply crash rule: the reply effect row is deleted only after the receipt settles, so a process stopped after its Source accepted the message but before `settle` runs this again on restart; each channel must find a message it already sent by its id and return `sent` without sending again (the channel's pre-send marker lookup on the hosting service looks for its id marker before every post). A stop before the send sends it once after restart. */
  private async deliver(id: string): Promise<void> {
    const { store, channels } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (!channels.enabled(receipt.channel.source)) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR))
      throw new Later('An earlier message of this ticket to this conversation waits')
    if (!channels.allowed(receipt.channel)) {
      store.receipts.settle(receipt, 'channelIgnored')
      return
    }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    const result = await channels.send(receipt)
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
