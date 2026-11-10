# Runtime contract

The host runs agents through one port, `AgentRuntime`, defined in `src/executor/contract.ts`. The WorkerExecutor and the Router host use only this port, so a runtime adapter is the only code that knows a particular agent runtime. This document states what every adapter must guarantee.

## Sessions

`open(spec)` starts a session for `spec.key` in `spec.cwd`, with the host tools in `spec.tools`. When `spec.resume` holds a session id that the runtime knows, the session continues that conversation and keeps the same session id. `probe()` reports whether the runtime enforces its network sandbox and the runtime version.

## Input modes

Every input has an id, a text and a mode:

- `steer`: the runtime reads the input in the running turn, at the next tool-call boundary. If the turn ends before such a boundary, the input starts the next turn. On an idle session it starts a new turn.
- `followup`: the input waits until the current turn ends and then starts a new turn. On an idle session it starts a new turn at once.
- `inject`: the input never starts a turn by itself. It is merged into the next `steer` or `followup` input sent to the session and is read together with it.

A runtime that cannot read input inside a running turn must treat `steer` as `followup`. That downgrade is allowed and must be documented by the adapter.

## Read receipts

`inputsRead` names the inputs that the runtime took into a step of the model. Each input id is reported at least once, and may be reported more than once. The host applies receipts idempotently by input id, so a repeated receipt changes nothing.

## Interrupt and close

`interrupt()` stops the running turn. No `turnEnded` event follows for the interrupted turn. `interrupt().stillQueued` lists the ids of inputs that were sent but not yet read. It includes pending `followup` and `inject` inputs that the adapter holds and has not yet handed to the runtime. `close()` ends the session. The `closed` event is the last event of a session.

## Event order

1. `session` is the first event of a session and carries its session id.
2. The `inputsRead` event for an input comes before the `turnEnded` event of the turn that read it.
3. Each turn ends with exactly one `turnEnded` event, unless it ends with an `error` event or is interrupted.
4. After an `error` event with `retryable: true`, the session stays open and the next input starts a new turn. After an `error` event with `retryable: false`, the `closed` event follows.
5. No event follows `closed`.

## Turn results and limits

`turnEnded` carries the turn's `outcome`, the `turns` and `costUsd` that this turn used (increments, not running totals), and `background`, the number of background tasks still running after the turn.

- `success`: the turn finished normally.
- `max_turns` or `budget`: the runtime stopped the turn at the limit in `spec.limits`. The host treats it as reaching the limit.
- `error`: the turn failed. The host reports the ticket as failed.

The host enforces `spec.limits` itself. It sums `turns` and `costUsd` per Assignment, across resumed sessions of that Assignment. When a sum exceeds `maxTurns` or `maxBudgetUsd`, or the runtime reports `max_turns` or `budget`, the host interrupts the session and reports the ticket as blocked with the summary `turn limit` or `budget limit`. The excess within one turn is tolerated. While `background` is above zero, the host keeps the session and its worker slot, and stops it 30 minutes after its last activity.
