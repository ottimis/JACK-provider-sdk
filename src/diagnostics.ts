/**
 * Provider-reported spawn diagnostics — advisory, non-fatal observations
 * about a session the user should see, surfaced as neutral data the host
 * renders generically.
 *
 * Motivating case
 * ---------------
 * Claude Code's interactive REPL warns at startup when a CLAUDE.md memory
 * file is oversized ("Large CLAUDE.md file detected (… chars > …)"). That
 * warning is **TUI-only**: it is never emitted on the headless
 * `stream-json` channel that Jack's CLI and SDK backends consume, so the
 * host cannot intercept it from the message stream. This capability lets
 * the provider re-derive equivalent observations from disk and hand them
 * to the host as structured, provider-neutral data.
 *
 * Design notes
 * ------------
 * - Strictly provider-neutral. The host renders a generic banner; it knows
 *   nothing about CLAUDE.md / AGENTS.md / GEMINI.md, token budgets, or any
 *   provider-specific config file. Each provider decides what is worth
 *   surfacing for its own runtime; Codex and Gemini MAY report on their
 *   own memory files or omit the capability entirely.
 * - Advisory only. Diagnostics NEVER block, fail, or delay a spawn. The
 *   host treats {@link DiagnosticsApi.inspectSpawn} as best-effort — an
 *   empty array, a rejected promise, or the provider omitting the whole
 *   capability all mean the same thing to the user: no banner.
 * - Presence-based gating. A provider that omits `JackProvider.diagnostics`
 *   simply produces no banners. No `CapabilityMatrix` flag — there is no
 *   persistent UI affordance to gate, mirroring `JackProvider.defaults`.
 * - Spawn-scoped. Diagnostics describe one pending/just-started session
 *   (keyed off its `cwd`); they are not an account- or app-level health
 *   surface. The host re-runs `inspectSpawn` on every spawn (new session,
 *   fork, resume-respawn) so the data always reflects disk as it is now.
 */

/**
 * Severity of a {@link ProviderDiagnostic}. Deliberately has no `'error'`
 * member: diagnostics are advisory and must never read as "the spawn
 * failed". A genuine spawn failure travels the normal error path, not
 * this one.
 *
 *   - `'info'`    — neutral note, host renders a low-emphasis banner.
 *   - `'warning'` — something the user probably wants to fix, host renders
 *                   an attention-coloured banner.
 */
export type ProviderDiagnosticSeverity = 'info' | 'warning'

/**
 * One advisory observation about a session, fully formatted by the
 * provider. The host renders every string field verbatim — it performs no
 * interpolation, localisation, or provider-aware formatting.
 */
export type ProviderDiagnostic = {
  /**
   * Stable machine id for the diagnostic *kind* (not the instance), e.g.
   * `'claude.memory.oversize'`. Used by the host as a React key and as the
   * dismiss key, so dismissing one banner does not hide unrelated ones.
   * Namespacing by provider id (`'<providerId>.<area>.<kind>'`) is the
   * recommended convention; the SDK does not enforce it.
   */
  id: string
  /** Drives banner colour / icon. See {@link ProviderDiagnosticSeverity}. */
  severity: ProviderDiagnosticSeverity
  /**
   * One-line human-readable headline, already formatted by the provider
   * (counts, file names, …). The host renders it verbatim as the banner
   * title.
   */
  title: string
  /**
   * Optional second line with supporting detail (per-file sizes, the
   * threshold that was crossed, a remediation hint). Rendered verbatim
   * below the title. Omit for a single-line banner.
   */
  detail?: string
  /**
   * Absolute paths of the files this diagnostic is about, if any. The host
   * MAY offer a per-path "open" affordance (File Viewer). Omit / leave
   * empty when the diagnostic is not file-anchored.
   */
  paths?: string[]
}

/**
 * Context the host hands to {@link DiagnosticsApi.inspectSpawn}. Carries
 * only what a provider needs to locate its on-disk config/memory files for
 * the session about to spawn.
 *
 * Kept intentionally small: new fields are additive (optional) so this can
 * grow — e.g. a resolved profile config dir — without a major SDK bump.
 */
export type DiagnosticsInspectContext = {
  /** Working directory of the session about to spawn. */
  cwd: string
  /**
   * Extra directories the session will be granted access to (workspace
   * root, `additionalDirectories`). Providers MAY scan these for
   * config/memory files too. The host passes the same set it puts on the
   * spawn; absent / empty means "just `cwd`".
   */
  additionalDirectories?: string[]
  /**
   * Host-controlled cancellation. The host aborts this when the spawn it
   * belongs to is cancelled before it lands. Providers SHOULD wire it into
   * their disk I/O and resolve `[]` (not reject) on abort.
   */
  signal?: AbortSignal
}

/**
 * Optional capability on {@link JackProvider}. A provider that exposes it
 * lets the host surface advisory, non-fatal observations about a session
 * as a generic banner.
 *
 * Presence-based: when the field is undefined the host shows no banners for
 * that provider and never calls in. There is no `CapabilityMatrix` flag.
 */
export type DiagnosticsApi = {
  /**
   * Inspect a pending spawn and return zero or more advisory diagnostics.
   *
   * Called by the host once per spawn, around the moment the agent process
   * starts. Implementations MUST be cheap — a bounded set of `stat()` /
   * `read()` calls, no network, well under ~100 ms — because the call sits
   * on the spawn path.
   *
   * Contract:
   *   - Return `[]` when there is nothing to report.
   *   - On any internal error, SHOULD resolve `[]` rather than reject;
   *     diagnostics are best-effort and must never surface as a spawn
   *     failure. (The host also defensively swallows rejections.)
   *   - On `ctx.signal` abort, resolve `[]`.
   *   - MUST NOT mutate disk or session state — read-only introspection.
   */
  inspectSpawn(ctx: DiagnosticsInspectContext): Promise<ProviderDiagnostic[]>
}
