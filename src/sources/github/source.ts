// Ported from dsh-superagent-prototype (MIT) src/sources/github.ts
/**
 * GitHub polling Source: the agent account's notifications, the PRs of open tickets with their CI,
 * and subscribed Threads, polled per repository. Each repository has its own cursors and health entry
 * (github:<owner>/<name>). Access and push permission are checked at start; an inaccessible repository is not polled.
 */
import { z } from 'zod'
import { key, liveTicket, type Thread } from '../../core/index.ts'
import { family } from '../../app/kv.ts'
import { CliError, validItems, type Commands, type Tally } from '../../infra/commands.ts'
import type { Health } from '../../infra/health.ts'
import { sameName } from '../../policy/actors.ts'
import { health, type SourceContext, type SourceService } from '../host.ts'
import type { SourceKind } from '../kind.ts'
import { cursorAt, pause, pollThreads as pollEach, type PollTimers } from '../poll.ts'
import { githubChannelAdapter } from './channel.ts'
import { ciCounts, ciFact, ciSummary, githubThreadContext, pullChecks, repositoryCommands } from './read.ts'
import { observePull, pullsOf, readPull, type Pull } from './pull.ts'
import {
  ciTrigger,
  commentTrigger,
  CommentSchema,
  configured,
  GithubConfigSchema,
  githubAddress,
  type GithubConfig,
  IssueSchema,
  issueTrigger,
  parseThreadId,
  pullTrigger,
  type PullRef,
  SOURCE,
  threadKeyOf,
} from './trigger.ts'

export const POLL_INTERVAL_MS = 60_000
export const FAILURES_BEFORE_ERROR = 3

export interface RepositoryAccess {
  accessible: boolean
  push: boolean
  at: string
  error?: string
}
export interface Retry {
  since: string
  pr: boolean
  failedAt?: string
  attempts?: number
}
export const GITHUB_STATE = {
  access: family<RepositoryAccess, [repository: string]>('repo-access:'),
  since: family<string, [repository: string]>('github-since:'),
  begun: family<string, [repository: string]>('github-begun:'),
  retries: family<Record<string, Retry>, [repository: string]>('github-retries:'),
  cursor: family<string, [repository: string, number: number]>(
    'github-cursor:',
    (repository, number) => `${repository}#${number}`,
  ),
  ci: family<{ fingerprint: string; revision: number }, [repository: string, number: number]>(
    'github-ci:',
    (repository, number) => `${repository}#${number}`,
  ),
}

/** Startup checks the app injects; a throw leaves `service.start` and refuses startup. */
export interface GithubStartupCheck {
  /** After the agent account lookup: the login, or undefined with the error when it could not be read. */
  login(login: string | undefined, error?: string): void
  /** After the access checks: the accessible repositories (possibly none). */
  access(accessible: readonly string[]): void
}

export interface GithubSourceOptions {
  repositories: readonly string[]
  commands: Commands
  timers?: PollTimers
  now?: () => number
  intervalMs?: number
  check?: GithubStartupCheck
}

/**
 * Reports a failed poll with its consecutive count: `ready` until `FAILURES_BEFORE_ERROR` consecutive failures,
 * `error` from then on.
 */
export function pollFailure(failures: number, error: unknown): Health {
  return health(failures >= FAILURES_BEFORE_ERROR ? 'error' : 'ready', 'pollFailures', {
    count: String(failures),
    error: String(error),
  })
}

/** A notification of the agent account; `subject.url` is the API address of its Issue or PR. */
const NotificationSchema = z.looseObject({
  repository: z.looseObject({ full_name: z.string() }),
  subject: z.looseObject({ url: z.string().nullish() }),
})
const RETRY_WINDOW_MS = 24 * 3600_000
/** Only 410 counts as deleted; 404 is retried because it can mean revoked access to a private repository. */
const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 410

export interface RepositoryPoll {
  repository: string
  login: string
  commands: Commands
  signal: AbortSignal
  now: () => number
}
interface Round {
  repository: string
  login: string
  api: Commands
  started: string
  signal: AbortSignal
  now: () => number
  pulls: Map<number, Promise<Pull>>
  read: Set<number>
  failures: string[]
  dropped: number[]
  abandoned: number[]
  tally: Tally
}
const stopped = (round: Round): boolean => round.signal.aborted

/** Deleted or abandoned threads are recorded without failing the round. */
function failed(ctx: SourceContext, round: Round, number: number, error: unknown, abandoned = false): void {
  if (deleted(error)) round.dropped.push(number)
  else if (abandoned) round.abandoned.push(number)
  else round.failures.push(`#${number}: ${String(error)}`)
  ctx.threads.patch(threadKeyOf(round.repository, number), { pollError: String(error) })
}

export async function pollRepository(ctx: SourceContext, poll: RepositoryPoll): Promise<number> {
  const round: Round = {
    repository: poll.repository,
    login: poll.login,
    api: repositoryCommands(poll.commands, poll.repository),
    started: new Date(poll.now()).toISOString(),
    signal: poll.signal,
    now: poll.now,
    pulls: new Map(),
    read: new Set(),
    failures: [],
    dropped: [],
    abandoned: [],
    tally: { skipped: 0 },
  }
  const notified = await pollNotifications(ctx, round).then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  )
  await pollTicketPulls(ctx, round)
  await pollThreads(ctx, round)
  if ('error' in notified) throw notified.error
  const { count, interval, rate } = notified.value
  if (poll.signal.aborted) return interval
  if (round.failures.length)
    throw new Error(`${round.failures.length} GitHub reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const named = (numbers: number[]) =>
    [...new Set(numbers)]
      .sort((a, b) => a - b)
      .map(number => `#${number}`)
      .join(', ')
  const dropped =
    (round.dropped.length ? `; deleted on GitHub: ${named(round.dropped)}` : '') +
    (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '') +
    (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  ctx.report(
    {
      state: 'ready',
      detail: `${count} notifications; next poll ≥ ${interval}s; rate limit ${rate.remaining ?? 'unknown'} remaining${dropped}`,
      at: round.started,
      values: {
        push: String(ctx.state.get(GITHUB_STATE.access(poll.repository))?.push ?? false),
        rateRemaining: rate.remaining ?? '',
        rateReset: rate.reset ?? '',
      },
    },
    poll.repository,
  )
  return interval
}

async function pollNotifications(
  ctx: SourceContext,
  round: Round,
): Promise<{ count: number; interval: number; rate: { remaining?: string; reset?: string } }> {
  const { state } = ctx
  const { repository, login } = round
  const since = state.get(GITHUB_STATE.since(repository)) ?? round.started
  if (state.get(GITHUB_STATE.since(repository)) === undefined) {
    state.set(GITHUB_STATE.since(repository), since)
    state.set(GITHUB_STATE.begun(repository), round.started)
  }
  const path = `notifications?all=true&per_page=50&since=${encodeURIComponent(since)}`
  const first = await round.api.response(path)
  const header = (name: string): string | undefined => /^\s*(\d+)/.exec(first.headers[name] ?? '')?.[1]
  const asked = Number(header('x-poll-interval') ?? 60)
  const interval = Math.max(60, Number.isFinite(asked) ? asked : 60)
  const rate = { remaining: header('x-ratelimit-remaining'), reset: header('x-ratelimit-reset') }
  const notifications = /rel="next"/.test(first.headers.link ?? '')
    ? await round.api.list(NotificationSchema, path, round.tally)
    : validItems(NotificationSchema, z.array(z.unknown()).parse(first.data), round.tally)
  const retries = { ...state.get(GITHUB_STATE.retries(repository)) }
  // Failed items from the previous round run first, then newly notified items in chronological order;
  // each is read once.
  const items = new Map<number, Retry>(
    Object.entries(retries).map(([number, retry]) => [Number(number), retry] as const),
  )
  for (const notification of notifications.reverse()) {
    if (!sameName(notification.repository.full_name, repository)) continue
    const address = githubAddress(notification.subject.url ?? '', [repository])
    if (!address || address.discussion || items.has(address.number)) continue
    const { number, pr } = address
    items.set(number, {
      since: [state.get(GITHUB_STATE.cursor(repository, number)) ?? since, since].sort().at(-1)!,
      pr,
    })
  }
  for (const [number, item] of items) {
    if (stopped(round)) return { count: notifications.length, interval, rate }
    round.read.add(number)
    try {
      await readNotified(ctx, round, number, item)
      delete retries[number]
    } catch (error) {
      if (stopped(round)) return { count: notifications.length, interval, rate }
      const retry = { ...item, failedAt: item.failedAt ?? round.started, attempts: (item.attempts ?? 0) + 1 }
      // Abandon notification retries after 24 hours of failures so a permanently unreadable thread does not hold
      // source health in error; its cursor stays so a later notification or thread poll still reads what was missed.
      const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
      failed(ctx, round, number, error, abandoned)
      if (!deleted(error) && !abandoned) {
        retries[number] = retry
        continue
      }
      delete retries[number]
    }
  }
  ctx.atomic(() => {
    state.set(GITHUB_STATE.since(repository), cursorAt(round.started))
    state.set(GITHUB_STATE.retries(repository), retries)
  })
  return { count: notifications.length, interval, rate }
}

async function readNotified(ctx: SourceContext, round: Round, number: number, item: Retry): Promise<void> {
  const { since } = item
  const { repository, login } = round
  const begun = Date.parse(ctx.state.get(GITHUB_STATE.begun(repository)) ?? '')
  const firstRead = ctx.state.get(GITHUB_STATE.cursor(repository, number)) === undefined
  let isPr = item.pr
  if (!isPr) {
    const issue = await round.api.get(IssueSchema, `issues/${number}`)
    // `issues/<n>` also returns PRs with `pull_request` set; handle them in the PR branch below.
    isPr = !!issue.pull_request
    if (!isPr) {
      // An Issue opened by someone other than the agent since the cursor brings its body so a mention in it reaches
      // the gate.
      // A mention added by a later edit to the body is not read: only the author can be the actor of the body.
      const created = Date.parse(issue.created_at)
      const opened =
        (created >= Date.parse(since) || (firstRead && created >= begun)) && !sameName(issue.user.login, login)
      if (opened) await ctx.receive(issueTrigger(issue, repository, login))
      await intakeComments(ctx, round, { repository, number, isPr: false, url: issue.html_url }, since)
      nameThread(ctx, repository, number, issue.title)
    }
  }
  if (isPr) {
    const pr = await pull(ctx, round, number)
    if (
      pr.created_at &&
      (Date.parse(pr.created_at) >= Date.parse(since) || (firstRead && Date.parse(pr.created_at) >= begun)) &&
      !sameName(pr.user.login, login)
    ) {
      const opened = {
        number,
        title: pr.title ?? '',
        body: pr.body,
        user: pr.user,
        created_at: pr.created_at,
        html_url: pr.html_url,
      }
      await ctx.receive(pullTrigger(opened, repository, login))
    }
    await intakeComments(
      ctx,
      round,
      { repository, number, isPr: true, url: pr.html_url, prAuthor: pr.user.login },
      since,
    )
    if (pr.title) nameThread(ctx, repository, number, pr.title)
  }
  ctx.state.set(GITHUB_STATE.cursor(repository, number), cursorAt(round.started))
  ctx.threads.patch(threadKeyOf(repository, number), { pollError: undefined })
}

/** Reads and observes a PR at most once per polling round. */
function pull(ctx: SourceContext, round: Round, number: number): Promise<Pull> {
  let read = round.pulls.get(number)
  if (!read) {
    read = readPull(round.api, round.repository, number).then(pr => {
      observePull(ctx, pr, round.now)
      return pr
    })
    round.pulls.set(number, read)
  }
  return read
}

async function intakeComments(ctx: SourceContext, round: Round, ref: PullRef, since: string): Promise<void> {
  const { login } = round
  const kinds = ref.isPr ? (['conversation', 'inline', 'review'] as const) : (['conversation'] as const)
  for (const kind of kinds) {
    const suffix = `&since=${encodeURIComponent(since)}`
    const path =
      kind === 'conversation'
        ? `issues/${ref.number}/comments?per_page=100${suffix}`
        : kind === 'inline'
          ? `pulls/${ref.number}/comments?per_page=100${suffix}`
          : `pulls/${ref.number}/reviews?per_page=100`
    const comments = await round.api.list(CommentSchema, path, round.tally)
    for (const comment of comments) {
      // Stopping mid-read throws so the thread's cursor stays where it was.
      if (stopped(round)) throw new Error('The GitHub Source stopped during the poll')
      const timestamp = Date.parse(comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? '')
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
      if (sameName(comment.user.login, login)) continue
      // A review decision without a body still reaches the ticket: a worker may be waiting for that approval.
      const trigger = commentTrigger(comment, ref, kind, login)
      if (trigger.text) await ctx.receive(trigger)
    }
  }
}

async function pollTicketPulls(ctx: SourceContext, round: Round): Promise<void> {
  const subscribed = ctx.threads.subscribed(SOURCE).flatMap(thread => {
    const parsed = parseThreadId(thread.ref.id)
    const live = thread.subscriptions.some(id => {
      const ticket = ctx.tickets.get(id)
      return !!ticket && liveTicket(ticket)
    })
    return parsed && sameName(parsed.repository, round.repository) && thread.meta.isPr === true && live
      ? [parsed.number]
      : []
  })
  const numbers = [
    ...new Set([...ctx.tickets.open().flatMap(ticket => pullsOf(ticket, round.repository, true)), ...subscribed]),
  ]
  for (const number of numbers) {
    if (stopped(round)) return
    try {
      const pr = await pull(ctx, round, number)
      if (pr.state !== 'closed' && !pr.merged) await pollChecks(ctx, round, number, pr)
    } catch (error) {
      if (!stopped(round)) failed(ctx, round, number, error)
    }
  }
}

/** Polls a PR's CI checks; only changes after the first baseline observation become Triggers. */
async function pollChecks(ctx: SourceContext, round: Round, number: number, pr: Pull): Promise<void> {
  const snapshot = await pullChecks(round.api, pr.head.sha, round.tally)
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(GITHUB_STATE.ci(round.repository, number))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous)
    await ctx.receive(
      ciTrigger(
        round.repository,
        pr,
        revision,
        ciSummary(snapshot, `PR #${number}`, `github/pulls/${number}/checks`),
        round.started,
      ),
    )
  ctx.state.set(GITHUB_STATE.ci(round.repository, number), { fingerprint, revision })
  ctx.threads.describe(threadKeyOf(round.repository, number), { facts: { ci: ciFact(ciCounts(snapshot)) } })
}

function nameThread(ctx: SourceContext, repository: string, number: number, title: string): void {
  ctx.threads.patch(threadKeyOf(repository, number), { title, repository, number })
  ctx.threads.describe(threadKeyOf(repository, number), {
    label: `${repository}#${number} ${title}`,
    facts: { number: { value: `#${number}` } },
  })
}

/** A deleted (410) Issue is still polled within the horizon and does not fail the round. */
async function pollThreads(ctx: SourceContext, round: Round): Promise<void> {
  const skip = (thread: Thread): boolean => {
    const parsed = parseThreadId(thread.ref.id)
    return !parsed || !sameName(parsed.repository, round.repository) || round.read.has(parsed.number)
  }
  await pollEach(
    ctx,
    SOURCE,
    () => stopped(round),
    async thread => {
      try {
        await pollThread(ctx, round, thread)
      } catch (error) {
        if (stopped(round)) throw error
        const number = parseThreadId(thread.ref.id)?.number ?? 0
        if (deleted(error)) round.dropped.push(number)
        else round.failures.push(`${thread.key}: ${String(error)}`)
        throw error
      }
    },
    skip,
    round.now,
  )
}

async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  const parsed = parseThreadId(thread.ref.id)
  if (!parsed) throw new Error('Subscribed thread has no GitHub issue or PR number')
  const { number } = parsed
  round.read.add(number)
  let current = thread
  if (typeof thread.meta.isPr !== 'boolean' || typeof thread.meta.title !== 'string') {
    const issue = await round.api.get(IssueSchema, `issues/${number}`)
    ctx.threads.patch(thread.key, {
      repository: round.repository,
      number,
      isPr: !!issue.pull_request,
      url: issue.html_url,
    })
    if (issue.title) nameThread(ctx, round.repository, number, issue.title)
    current = ctx.threads.get(thread.key) ?? thread
  }
  const checkpoint = GITHUB_STATE.cursor(round.repository, number)
  const since = ctx.state.get(checkpoint) ?? current.createdAt
  if (current.meta.isPr === true) {
    const pr = await pull(ctx, round, number)
    await intakeComments(
      ctx,
      round,
      { repository: round.repository, number, isPr: true, url: pr.html_url, prAuthor: pr.user.login },
      since,
    )
  } else await intakeComments(ctx, round, { repository: round.repository, number, isPr: false }, since)
  ctx.state.set(checkpoint, cursorAt(round.started))
}

export function githubSource(options: GithubSourceOptions): { kind: SourceKind<GithubConfig>; service: SourceService } {
  const now = options.now ?? Date.now
  const interval = Math.max(POLL_INTERVAL_MS, options.intervalMs ?? POLL_INTERVAL_MS)
  const iso = (): string => new Date(now()).toISOString()
  let login: string | undefined
  let controller: AbortController | undefined
  let running: Promise<void> | undefined

  const scopeOf = (meta: Record<string, unknown>): 'issues' | 'pulls' | 'comments' | undefined => {
    if (meta.kind === 'issue') return 'issues'
    if (meta.kind === 'pull') return 'pulls'
    return meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'review' ? 'comments' : undefined
  }

  async function prepare(
    ctx: SourceContext,
    signal: AbortSignal,
  ): Promise<{ login: string; accessible: string[] } | undefined> {
    const commands = options.commands.withSignal(signal)
    let account: string
    try {
      account = (await commands.get(z.looseObject({ login: z.string() }), 'user')).login
    } catch (error) {
      ctx.report({ state: 'error', detail: `Could not read the agent account: ${String(error)}`, at: iso() })
      ctx.log('error', 'github.account_failed', { error: String(error) })
      options.check?.login(undefined, String(error))
      return undefined
    }
    login = account
    options.check?.login(account)
    const accessible: string[] = []
    for (const repository of options.repositories) {
      if (signal.aborted) return undefined
      const at = iso()
      let access: RepositoryAccess
      try {
        const repo = await repositoryCommands(commands, repository).get(
          z.looseObject({
            full_name: z.string(),
            permissions: z.looseObject({ push: z.boolean().optional() }).nullish(),
          }),
          '',
        )
        access = { accessible: true, push: repo.permissions?.push === true, at }
        accessible.push(repository)
        ctx.report(
          {
            state: 'ready',
            detail: `Accessible as @${account}; push ${access.push ? 'allowed' : 'not allowed'}`,
            at,
            values: { push: String(access.push) },
          },
          repository,
        )
      } catch (error) {
        access = { accessible: false, push: false, at, error: String(error) }
        ctx.report(
          { state: 'error', detail: `Not accessible: ${String(error)}`, at, values: { push: 'false' } },
          repository,
        )
      }
      ctx.state.set(GITHUB_STATE.access(repository), access)
      ctx.log('info', 'github.repository_access', { repository, accessible: access.accessible, push: access.push })
    }
    ctx.report({
      state: accessible.length ? 'ready' : 'error',
      detail: accessible.length
        ? `Watching ${accessible.length} of ${options.repositories.length} repositories as @${account}`
        : 'No configured repository is accessible',
      at: iso(),
    })
    options.check?.access(accessible)
    return accessible.length ? { login: account, accessible } : undefined
  }

  async function watch(
    ctx: SourceContext,
    ready: { login: string; accessible: string[] },
    signal: AbortSignal,
  ): Promise<void> {
    const failures = new Map<string, number>()
    while (!signal.aborted) {
      let wait = interval
      for (const repository of ready.accessible) {
        if (signal.aborted) return
        try {
          const asked = await pollRepository(ctx, {
            repository,
            login: ready.login,
            commands: options.commands.withSignal(signal),
            signal,
            now,
          })
          wait = Math.max(wait, asked * 1000)
          failures.set(repository, 0)
        } catch (error) {
          if (signal.aborted) return
          const count = (failures.get(repository) ?? 0) + 1
          failures.set(repository, count)
          ctx.report(pollFailure(count, error), repository)
          ctx.log('warn', 'github.poll_failed', { repository, count, error: String(error) })
        }
      }
      await pause(wait, signal, options.timers)
    }
  }

  const kind: SourceKind<GithubConfig> = {
    kind: SOURCE,
    schema: GithubConfigSchema,
    scope: ({ meta }) => {
      const row = scopeOf(meta)
      return { listened: true, observed: false, ...(row ? { row } : {}) }
    },
    channel: githubChannelAdapter({
      commands: options.commands,
      repositories: options.repositories,
      login: () => login,
    }),
    threadContext: githubThreadContext(options.commands, options.repositories),
    find: query => {
      const text = query.trim()
      const named = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(text)
      if (named) {
        const repository = configured(options.repositories, named[1]!)
        return { threads: repository ? [threadKeyOf(repository, Number(named[2]))] : [], terms: [] }
      }
      const bare = /^#?(\d+)$/.exec(text)
      if (bare)
        return { threads: options.repositories.map(repository => threadKeyOf(repository, Number(bare[1]))), terms: [] }
      const link = /github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/i.exec(text)
      if (link) {
        const repository = configured(options.repositories, link[1]!)
        return { threads: repository ? [threadKeyOf(repository, Number(link[2]))] : [], terms: [] }
      }
      return { threads: [], terms: [] }
    },
  }

  const service: SourceService = {
    kind: SOURCE,
    start: async (host, signal) => {
      const ctx = host.context(SOURCE)
      controller = new AbortController()
      const lifetime = AbortSignal.any([signal, controller.signal])
      const ready = await prepare(ctx, lifetime)
      if (!ready) return
      // Unhandled rejections terminate the daemon, so a failure escaping the polling loop
      // is reported as health instead.
      running = watch(ctx, ready, lifetime).catch((error: unknown) => {
        ctx.report({ state: 'error', detail: String(error), at: iso() })
      })
    },
    stop: async () => {
      controller?.abort()
      await running
    },
  }

  return { kind, service }
}
