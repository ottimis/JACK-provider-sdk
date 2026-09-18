/**
 * Host primitives exposed to providers — handed in via
 * {@link JackProvider.activate} so provider code never imports `electron`,
 * `better-sqlite3`, or any other host-internal module directly.
 *
 * Why this exists
 * ---------------
 * In Jack v0.4.x the Claude provider reached into Electron (`safeStorage`,
 * `BrowserWindow`, `session`) and Jack's settings table (`getSetting` /
 * `setSetting`) to persist its login cookie. That breaks two goals:
 *
 *   1. **Out-of-tree packages.** A future `@third-party/jack-provider-foo`
 *      installed from npm shouldn't need to know about the host's storage
 *      layer or its windowing toolkit.
 *   2. **Testability.** Provider unit tests on plain Node want a fake host
 *      that returns canned credentials, not a real `safeStorage`.
 *
 * `HostServices` is the contract that satisfies both: a tiny set of
 * primitives the host implements once (with whatever it has — Electron in
 * Jack's case, but a CLI host could use `keytar` + headless puppeteer)
 * and providers consume through dependency injection.
 *
 * Surface stays intentionally small. New capabilities grow this file as
 * specific providers need them — but the rule is "host-side knowledge
 * doesn't leak out the SDK". A provider that needs deep host integration
 * is a sign that the integration belongs in the host, not in the
 * provider.
 *
 * Lifecycle
 * ---------
 * The host calls `provider.activate(host)` once during registration. The
 * provider stores the `host` reference and uses it lazily — no host
 * primitive may be invoked before activation. Methods that need the host
 * must guard accordingly (typically by deferring all work to a closure).
 */

/**
 * Per-provider key/value store. Keys are namespaced automatically by the
 * calling provider's id, so `kv.set('token', x)` from `claudeProvider`
 * lands in a different bucket than the same call from `codexProvider`.
 *
 * Values are strings — callers serialize JSON / numbers / booleans
 * themselves. `null` from `get` / `getSecret` means "no value stored",
 * not "value is null"; explicit removal goes through `remove`.
 *
 * `setSecret` / `getSecret` route through the host's OS-level keychain
 * encryption when available (Electron's `safeStorage`, `keytar`, etc.).
 * `setSecret` MUST throw when no secure storage is available so providers
 * never silently degrade to plaintext on unsupported systems.
 */
export type HostKvScope = {
  /** Plain (unencrypted) read. */
  get(key: string): string | null
  /** Plain (unencrypted) write. */
  set(key: string, value: string): void
  /** Remove the value at `key`. Idempotent (no-op when the key is absent). */
  remove(key: string): void
  /** Encrypted read. Returns `null` when the key is absent OR the host's secret store can't decrypt (e.g. user wiped keychain). */
  getSecret(key: string): string | null
  /** Encrypted write. Throws when secure storage isn't available — providers should surface a clear error to the user, not fall back to plaintext. */
  setSecret(key: string, value: string): void
}

/**
 * Options for {@link HostAuthService.openCookieLoginWindow}.
 *
 * The host opens a child auth window at `url` and polls the cookie jar
 * until `cookieName` appears on `cookieDomain`. When the cookie shows up
 * the host returns its value and closes the window.
 *
 * Each provider's auth flow lives in its own session partition so two
 * providers can be "logged in" simultaneously without their cookies
 * colliding in the host's shared cookie store.
 */
export type CookieLoginOptions = {
  /** URL to open in the child window. */
  url: string
  /** Name of the cookie the provider waits for (e.g. `'sessionKey'`). */
  cookieName: string
  /** Cookie domain to scope the lookup (e.g. `'https://claude.ai'`). */
  cookieDomain: string
  /**
   * Storage partition string for session isolation. Convention:
   * `persist:<provider-id>-<flow-name>` (e.g. `persist:claude-usage`).
   * Different partition strings keep parallel logins independent.
   */
  partition: string
  /** Window title shown in the OS chrome. Default: `'Connect'`. */
  title?: string
  /** Hard timeout in milliseconds. Default: 5 minutes. */
  timeoutMs?: number
  /** Window width in pixels. Default: 520. */
  width?: number
  /** Window height in pixels. Default: 720. */
  height?: number
  /**
   * Optional parent window the host narrows internally to attach
   * modality. Typed as `unknown` so the SDK doesn't depend on Electron.
   */
  parentWindow?: unknown
}

/**
 * Result of a cookie-login flow.
 *
 *   - `'success'` — cookie captured; `cookieValue` is the raw value.
 *   - `'cancelled'` — user closed the window before the cookie appeared.
 *   - `'timeout'` — `timeoutMs` elapsed without the cookie being set.
 *   - `'error'` — host couldn't open the window (e.g. running headless,
 *     no display server, partition rejected). Providers should surface
 *     `error` to the user as an actionable message.
 */
export type CookieLoginResult =
  | { kind: 'success'; cookieValue: string }
  | { kind: 'cancelled' }
  | { kind: 'timeout' }
  | { kind: 'error'; error: string }

/**
 * Auth primitives the host provides. Today only cookie-based login;
 * OAuth / device-code flows can be added as future providers need them
 * without breaking existing implementations (`HostAuthService` is an
 * open-shape type — additions are purely additive).
 */
export type HostAuthService = {
  /**
   * Open a child window at the given URL and wait for the named cookie
   * to appear. Used by providers whose login flow is "send the user to
   * a web page, scrape the session cookie when they sign in".
   *
   * The host is responsible for: opening the window, polling cookies,
   * closing the window when the cookie shows up (or the user cancels /
   * times out), and isolating the session partition. The provider
   * doesn't see Electron, BrowserWindow, or any windowing detail.
   */
  openCookieLoginWindow(opts: CookieLoginOptions): Promise<CookieLoginResult>
}

/**
 * JSON-serializable value — what the host can persist on the provider's
 * behalf in {@link HostFileDerivedCache}. Anything outside this union
 * (a `Date`, a `Map`, a class instance, `undefined`) doesn't survive the
 * round-trip through the host's store, so providers derive plain data.
 */
export type HostJsonValue =
  | null
  | boolean
  | number
  | string
  | HostJsonValue[]
  | { [key: string]: HostJsonValue }

/**
 * Cache of values a provider derives from a file — e.g. the session summary
 * parsed out of a transcript — invalidated by the file's identity on disk.
 * Scoped per provider by the host, like {@link HostServices.kv}, and keyed by
 * (provider id, absolute path).
 *
 * Why it exists: session discovery re-reads and re-parses every transcript on
 * disk on every request, while the files rarely change. The provider keeps
 * owning *where* its files live and *how* to parse them (formats are
 * provider-specific); the host owns deciding whether it already has the
 * answer — it `stat`s, compares, persists, and prunes.
 *
 * Semantics, in short:
 *
 *   - **Hit** — `stat` succeeds and `mtimeMs`, `size` and `version` all match
 *     the stored row ⇒ the stored value is returned and `compute` is NOT called.
 *   - **Miss** — `compute()` runs; its result is stored against the `stat`
 *     taken *before* it ran, then returned.
 *   - **`null` result** — stored like any other value: "this file is not a
 *     session" (a sidechain, say) is remembered too.
 *   - **`stat` fails** — the row is dropped, `compute` is NOT called, `null`
 *     is returned.
 *   - **`compute` throws** — nothing is stored and the error propagates to
 *     the caller; errors are never cached.
 *   - **Oversized value** — returned but not stored (the host caps the
 *     serialized size), so it recomputes every time: keep entries small.
 *   - **Concurrent identical calls** share one `compute`.
 *   - **File changed during `compute`** — the row carries the older `stat`, so
 *     the next call misses and recomputes: at worst one extra parse, never a
 *     stale value kept.
 *
 * Contract: `_shared/api/host-file-cache.md`.
 */
export type HostFileDerivedCache = {
  /**
   * Return the value stored for `filePath` when the file's mtime and size and
   * the given `version` are unchanged; otherwise run `compute`, store its
   * result and return it.
   *
   * `filePath` must be an absolute path and is compared as given — pass the
   * same path the provider actually reads, or the same file cached under two
   * spellings occupies two rows.
   *
   * `version` is the provider's parser version. **Bump it whenever the shape
   * or the derivation of the value changes**, otherwise rows written by the
   * old parser keep being served for unchanged files.
   */
  getOrCompute<T extends HostJsonValue>(
    filePath: string,
    version: string,
    compute: () => Promise<T | null>
  ): Promise<T | null>
  /**
   * Forget the entries under `root` whose path is not in `livePaths` — call it
   * after a *complete* scan of `root` so deleted files don't accumulate.
   * Calling it after a partial scan drops entries that are still live (they
   * are recomputed on the next hit, so it costs time, not correctness).
   */
  prune(root: string, livePaths: Iterable<string>): Promise<void>
}

/**
 * The bag of host services injected into a provider via
 * {@link JackProvider.activate}. Providers store the reference and
 * pull primitives lazily.
 *
 * Adding a new capability:
 *   1. Define the new service interface in this file (or a sibling).
 *   2. Add it as an optional field here so older providers that don't
 *      use it keep compiling.
 *   3. Document the feature flag — providers that need the capability
 *      should guard with `if (!host.newCapability) return undefined`
 *      and the host implements it.
 *
 * Concrete services exposed today are documented in their own types.
 */
export type HostServices = {
  /** Per-provider key/value store. Namespaced by provider id by the host. */
  kv: HostKvScope
  /** Auth flow primitives (cookie login today; OAuth / device-code in the future). */
  auth: HostAuthService
  /**
   * Number of sessions currently pinned to a given profile id. Used by
   * providers that surface profiles (`JackProvider.profiles`) to gate
   * destructive operations:
   *
   *   - `remove(profileId)` refuses when count > 0 so the user can't
   *     orphan the chat history of any pinned session.
   *   - `update(profileId, { configDir })` may surface a confirm dialog
   *     when count > 0 (UI-side concern; the API itself stays open since
   *     the user can move the on-disk `projects/`/rollouts folder
   *     manually to preserve history).
   *
   * Optional: providers without a profile concept never call it. The
   * host implementation reads `SELECT COUNT(*) FROM sessions WHERE
   * profile_id = ?`.
   */
  profileUsageCount?(profileId: string): number
  /**
   * Cache of values derived from files on disk (transcripts, rollouts),
   * keyed by the file's mtime + size + a provider-supplied parser version.
   *
   * Optional: **absent on hosts that predate it** — providers must guard and
   * fall back to computing directly:
   *
   * ```ts
   * const info = host.fileCache
   *   ? await host.fileCache.getOrCompute(file, PARSER_VERSION, () => parse(file))
   *   : await parse(file)
   * ```
   *
   * The cached output must be identical to the uncached one.
   */
  fileCache?: HostFileDerivedCache
}
