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
}
