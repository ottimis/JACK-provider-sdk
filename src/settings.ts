/**
 * Provider-declared configuration toggles — boolean settings a provider
 * exposes so the host can render a generic on/off control and persist the
 * value, without the host knowing anything provider-specific.
 *
 * Motivating case
 * ---------------
 * Claude Code has a `/config` toggle, "switch models when a message is
 * flagged" (`switchModelsOnFlag`), that controls Fable 5's content-based
 * safety fallback to Opus. It is a TUI-only affordance: Jack's headless
 * `stream-json` backends can't reach it. This capability lets the Claude
 * provider surface that toggle to Jack, and the host render + persist it,
 * with zero `if (provider === 'claude')` in the host — the host only ever
 * sees an opaque list of `{ id, label, ... }` toggles it round-trips
 * through {@link ProviderSettingsApi.get} / {@link ProviderSettingsApi.set}.
 *
 * Design notes
 * ------------
 * - Fully provider-neutral. The host lists toggles, renders a switch per
 *   entry, and calls back in to read/write. It never interprets an `id`.
 * - Presence-based gating, like {@link JackProvider.defaults} /
 *   {@link JackProvider.diagnostics}: a provider that omits
 *   `JackProvider.settings` exposes no toggles and the host renders nothing.
 *   No `CapabilityMatrix` flag.
 * - The provider owns storage and precedence. For a `'project'`-scoped
 *   toggle the Claude provider reads/writes `<project>/.claude/settings.json`
 *   (which its own headless CLI already loads via `--setting-sources`); the
 *   host just passes the `projectPath`.
 * - v1 is boolean-only. Richer control kinds (enum, string) can extend
 *   {@link ProviderSettingToggle} additively later.
 */

/**
 * Where a toggle's value is stored. `'project'` scopes it to a single
 * project/repository; `'user'` applies it to every session for that
 * provider. A toggle declares which scopes it supports via
 * {@link ProviderSettingToggle.scopes}; the host asks the user (or defaults)
 * and passes the chosen scope back on every get/set.
 */
export type ProviderSettingScope = 'project' | 'user'

/**
 * One boolean toggle a provider exposes. All strings are rendered verbatim
 * by the host — no interpolation or localisation.
 */
export type ProviderSettingToggle = {
  /**
   * Stable machine id for the toggle, opaque to the host and used as its
   * React key + the argument to {@link ProviderSettingsApi.get} / `set`.
   * Namespacing by provider (`'<providerId>.<area>'`) is recommended, e.g.
   * `'claude.switchModelsOnFlag'`; the SDK does not enforce it.
   */
  id: string
  /** Human-facing label for the switch (host renders as-is). */
  label: string
  /** Optional longer explanation shown near the switch. */
  description?: string
  /**
   * Value used when the toggle is unset in every supported scope — what the
   * provider's runtime does by default. The host shows this until the user
   * changes it. (For `switchModelsOnFlag` the default is `true`: the
   * automatic fallback is on unless disabled.)
   */
  default: boolean
  /**
   * Scopes this toggle can be written to, in the order the host should
   * prefer/offer them. Must be non-empty. A `'project'`-only toggle
   * requires a `projectPath` on every call.
   */
  scopes: ProviderSettingScope[]
}

/**
 * Context the host passes on every {@link ProviderSettingsApi} call so the
 * provider can resolve scope-dependent storage.
 */
export type ProviderSettingContext = {
  /**
   * Absolute path of the session's project. Required whenever `scope` is
   * `'project'`; ignored for `'user'`. The provider rejects a `'project'`
   * call with no `projectPath`.
   */
  projectPath?: string
}

/**
 * Optional capability: declare and persist boolean configuration toggles.
 * Attach to {@link JackProvider.settings}. Every method is best-effort from
 * the host's perspective — a rejected promise degrades to "no toggle" / "no
 * change", never a crash.
 */
export type ProviderSettingsApi = {
  /**
   * The toggles this provider exposes. Called by the host to build the UI.
   * Pure/synchronous: return a static declaration, not I/O.
   */
  toggles(): ProviderSettingToggle[]
  /**
   * Read the effective value of `id` at `scope`. The provider resolves it
   * from its own storage (e.g. the project `settings.json`), falling back to
   * the toggle's {@link ProviderSettingToggle.default} when unset.
   */
  get(
    id: string,
    scope: ProviderSettingScope,
    ctx: ProviderSettingContext
  ): Promise<boolean>
  /**
   * Persist `value` for `id` at `scope`. Takes effect on the provider's next
   * spawn for the affected scope (the host does not force a respawn).
   */
  set(
    id: string,
    scope: ProviderSettingScope,
    value: boolean,
    ctx: ProviderSettingContext
  ): Promise<void>
}
