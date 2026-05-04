/**
 * Usage / billing capability — provider-owned data flow.
 *
 * Each provider knows how to talk to its own billing surface (Claude
 * cookie API for Pro/Max, OpenAI usage endpoints for Codex, Gemini's
 * Google Cloud quotas, …) and how to map its SDK's per-message token
 * counts into a canonical shape. The host runs a generic poll loop and
 * a generic chip — it never special-cases any provider.
 *
 * Two surfaces:
 *
 *   - `fetch()` for **account-level** snapshots. Pulled by a host poller
 *     on `recommendedPollIntervalSec` cadence (clamped to host bounds).
 *     What "account" means is provider-defined: Claude → org, Codex →
 *     OpenAI project, Gemini → Cloud Billing project.
 *
 *   - `formatSessionMetrics()` for **per-session** translation. The
 *     manager already calls `backend.getContextUsage()` after every
 *     `assistant` message; that returns a loose `AgentContextUsage`
 *     bag. This hook lets the provider lift it into canonical
 *     {@link UsageMetric}[] without the host trying to interpret
 *     provider-specific fields.
 *
 * Single source of truth: the provider. Host plumbs, never decodes.
 *
 * Optional everywhere — providers without billing visibility (Codex
 * without admin keys, Gemini without OAuth) leave `fetch()` returning
 * an empty `metrics: []`. The capability flag stays `true` if the
 * provider can format per-session metrics, `false` if it has nothing
 * to say at all.
 */

import type { AgentContextUsage } from './backend'

/**
 * Canonical metric kinds. New kinds extend this union additively when a
 * provider has a meaningfully different shape (e.g. a future
 * `quarterly_burn` for enterprise billing). Adding a kind is a minor
 * SDK bump; the renderer's dispatch table grows alongside.
 */
export type UsageMetric = TimeWindowMetric | TokenUtilizationMetric | MonthlySpendMetric

/**
 * Rolling-window utilization. The classic Claude Pro/Max bucket
 * (5-hour, 7-day) — utilization 0..1 with a hard reset boundary.
 *
 * Optional `used` / `limit` / `unit` carry raw counts when the
 * provider exposes them (Gemini free-tier daily quota: 12 of 50
 * requests). Claude's cookie API gives only `utilization`, so those
 * stay undefined and the chip falls back to "X% of N-hour usage".
 */
export type TimeWindowMetric = {
  kind: 'time_window'
  /** Stable, provider-defined key. e.g. `'five_hour'`, `'seven_day_opus'`, `'daily'`. */
  id: string
  /** Human-readable label for UI. Provider supplies (i18n is its concern). */
  label: string
  /** Window utilization in [0, 1]. */
  utilization: number
  /** Optional: raw count consumed in the window (when known). */
  used?: number
  /** Optional: raw cap of the window (when known). */
  limit?: number
  /** Optional: unit of `used`/`limit`. Default `'tokens'`. Chip uses for formatting. */
  unit?: 'tokens' | 'requests' | (string & {})
  /** ISO 8601 timestamp when the window resets. */
  resetsAt: string
  /** Window length in seconds. Used for elapsed-progress UI. */
  windowSeconds: number
}

/**
 * Count-based utilization without a time boundary. Used for context
 * window pressure ("X tokens of Y max") and any cumulative provider
 * metric that doesn't reset on a clock (lifetime / billing-period
 * tokens, etc).
 *
 * `max` is optional — a provider tracking total token consumption
 * without a hard cap (analytics, not gating) leaves it undefined and
 * the chip shows just the count.
 */
export type TokenUtilizationMetric = {
  kind: 'token_utilization'
  /** Stable, provider-defined key. e.g. `'context'`, `'session_total'`. */
  id: string
  /** Human-readable label for UI. */
  label: string
  /** Tokens consumed. */
  used: number
  /** Optional cap. Undefined = no cap, chip hides the ratio. */
  max?: number
}

/**
 * Spend on a billing cycle (typically monthly). Only meaningful for
 * providers using API-key auth — subscription users have rolling-window
 * quotas, not $-spend.
 *
 * `budgetUsd` is optional: most users don't set a budget, so the chip
 * shows raw spend without a denominator. When present, chip can render
 * a budget bar.
 */
export type MonthlySpendMetric = {
  kind: 'monthly_spend'
  id: string
  /** Cycle label, e.g. "May 2026" or "Current cycle". */
  label: string
  spentUsd: number
  budgetUsd?: number
  /** ISO 8601 — start of the billing cycle. */
  cycleStart: string
  /** ISO 8601 — end of the billing cycle. */
  cycleEnd: string
}

/**
 * One snapshot of provider-side usage data, as returned by
 * {@link UsageApi.fetch}. `metrics` may be empty when the provider has
 * no account-level data to report (Codex without billing key, etc.).
 */
export type UsageSnapshot = {
  metrics: UsageMetric[]
  /** ISO 8601 — when this snapshot was observed. */
  observedAt: string
  /** Verbatim provider payload, kept for debug / future analytics.
   *  Never consumed by host or chip directly. */
  raw?: unknown
}

/**
 * Connection / authorization state of the provider's usage surface.
 * Surface in the chip's pop-over so the user knows whether they're
 * tracking real numbers or seeing a cached / disconnected snapshot.
 */
export type UsageStatus = {
  connected: boolean
  /** Optional human-readable identity (org name, email, project id). */
  identity?: string
  /**
   * Provider-defined auth-mode hint. Lets the renderer adapt copy
   * (e.g. "Connected as API user" vs "Pro subscription"). Stable
   * provider-supplied strings; host doesn't interpret beyond
   * passthrough.
   */
  authMode?: 'subscription' | 'api_key' | (string & {})
  /** Last error message, when not connected. */
  error?: string
}

/**
 * Result of {@link UsageApi.connect}. The `'choose'` branch covers
 * multi-org / multi-project accounts where the user must pick one
 * (Claude's multi-org case). Generalising to a generic option list
 * means the chip's UI doesn't special-case any provider.
 */
export type UsageConnectResult =
  | { kind: 'ready'; identity: string }
  | { kind: 'choose'; options: UsageConnectOption[] }
  | { kind: 'error'; error: string }
  | { kind: 'cancelled' }

export type UsageConnectOption = {
  id: string
  label: string
}

/**
 * Context handed to {@link UsageApi.connect}. Currently just a parent
 * window for Electron-coupled flows (Claude opens a child BrowserWindow
 * on `claude.ai/login`). Typed as `unknown` here so the SDK doesn't
 * pull in `electron` as a peer dep — the host narrows to
 * `BrowserWindow` at the call site.
 */
export type UsageConnectContext = {
  /** Parent window for any modal flow the provider needs to open. */
  parentWindow?: unknown
}

/**
 * Provider-owned usage capability. Optional on {@link JackProvider};
 * absent = host hides the chip's "Connect" affordance and the
 * capability flag is `false`.
 */
export type UsageApi = {
  /** Current connection state — used for chip display + gating. */
  status(): Promise<UsageStatus>

  /**
   * Open the provider's connect flow. Whatever modality the provider
   * needs (login window, API-key picker, OAuth redirect) lives here.
   */
  connect(ctx: UsageConnectContext): Promise<UsageConnectResult>

  /**
   * When `connect()` returned `'choose'`, host calls this with the
   * user's pick. Optional — providers that never choose omit it.
   */
  selectOption?(optionId: string): Promise<UsageConnectResult>

  /** Drop credentials and stop any provider-side polling. */
  disconnect(): Promise<void>

  /**
   * Fetch one fresh account-level snapshot. Empty `metrics: []` is
   * fine when the provider has no billing surface yet — the capability
   * stays `true` for the per-session bridge.
   */
  fetch(): Promise<UsageSnapshot>

  /**
   * Recommended poll cadence (seconds). Host clamps to its bounds.
   * Optional — host falls back to its own default if unset.
   */
  recommendedPollIntervalSec?: number

  /**
   * Translate the loose {@link AgentContextUsage} the manager pulls from
   * `backend.getContextUsage()` into canonical {@link UsageMetric}[].
   *
   * Pure function (no side effects) — provider knows its own SDK's
   * shape and lifts it. Empty array OK when the raw bag has nothing
   * useful (e.g. fresh session before any message lands).
   *
   * Optional. Providers without per-session token visibility omit it
   * and the chip skips the per-session row.
   */
  formatSessionMetrics?(raw: AgentContextUsage): UsageMetric[]
}
