/**
 * SandboxApi — provider-declared Docker sandbox capability.
 *
 * Jack runs sessions in a Docker container ("sandbox mode") to isolate the
 * provider's CLI from the host filesystem and network. The container itself
 * is generic — Jack owns the Docker orchestration, security policy (CapDrop,
 * memory cap, non-privileged), project mount, and user-defined shared
 * volumes. The PROVIDER-SPECIFIC bits live here:
 *
 *   - which image to pull (each provider needs its own CLI installed)
 *   - which binary name to invoke inside the container (used by the host to
 *     rewrite host-resolved absolute paths like
 *     `/Users/foo/.local/bin/claude` to a bare command the container's
 *     PATH resolves)
 *   - which config dir to mount (`~/.claude`, `~/.codex`, `~/.gemini`, …)
 *   - optional env extras
 *
 * A provider declaring `sandbox` opts itself into sandbox mode. The
 * matching capability flag {@link CapabilityMatrix.sandbox} MUST be `true`
 * — the host derives it from `provider.sandbox != null` at registration.
 *
 * Providers that don't declare `sandbox` (or set it to `undefined`) are
 * treated as sandbox-incompatible: the host hides the toggle in the UI and
 * blocks spawn-time requests with a clear error.
 *
 * The host's distribution model expects images at
 * `ghcr.io/ottimis/jack-sandbox-<provider-id>:<X.Y.Z>` (monorepo
 * `github.com/ottimis/JACK-sandbox`). Providers can point `defaultImage`
 * elsewhere — third-party plugin authors who maintain their own image are
 * free to host wherever they like.
 */

/**
 * Mount a named Docker volume into the container at {@link containerPath}.
 * The pattern Anthropic recommends for CLI config dirs (see
 * https://code.claude.com/docs/en/devcontainer#persist-authentication-and-settings-across-rebuilds):
 * the volume is auto-created on demand, persists across container
 * restarts, and isolates writes from the host filesystem entirely.
 * Best fit for `~/.claude`, `~/.codex`, `~/.gemini` since they hold auth
 * tokens, session JSONLs, and CLI-mutated settings.
 *
 * Read-only is recommended whenever the CLI doesn't genuinely need to
 * mutate state. Set `readOnly: false` when the CLI writes back — Claude
 * writes session-env, project history, MCP additions; Codex appends
 * thread JSONL; etc.
 */
export type SandboxConfigMount = {
  /**
   * Docker volume name. The host auto-creates the volume if missing
   * (via `docker volume create <name>`). Use a stable, namespaced name
   * like `jack-sandbox-<provider>-config` so volumes can be inspected
   * / pruned predictably from the Docker CLI.
   *
   * Volumes are NOT scoped per session by default — sharing one volume
   * across sandbox sessions of the same provider is the common case
   * and matches Anthropic's reference. If you need per-session
   * isolation, embed the session id in the name.
   */
  readonly volumeName: string
  /** Absolute container path. */
  readonly containerPath: string
  /** When `true`, the host adds `:ro` to the bind. */
  readonly readOnly: boolean
}

/**
 * Provider-declared Docker sandbox capability. Optional on
 * {@link JackProvider}; when present the matching
 * {@link CapabilityMatrix.sandbox} flag MUST be `true`.
 */
export interface SandboxApi {
  /**
   * Default image reference, pinned per provider release. Format:
   * `<registry>/<repo>:<tag>`. Users can override per-provider via the host
   * setting `sandbox.image.<providerId>`.
   *
   * For Jack's first-party providers the recommended location is
   * `ghcr.io/ottimis/jack-sandbox-<providerId>:<X.Y.Z>` (monorepo built
   * from `github.com/ottimis/JACK-sandbox`). Third-party plugins are free
   * to host elsewhere.
   */
  readonly defaultImage: string

  /**
   * CLI binary name as it should be invoked inside the container (e.g.
   * `'claude'`, `'codex'`, `'gemini'`). Used by the host's spawner to
   * rewrite host-resolved absolute binary paths to a bare command the
   * container's PATH resolves.
   *
   * The image MUST install this binary at a location reachable from
   * `$PATH` (typically `/usr/local/bin/<binaryName>` via `npm install -g`).
   */
  readonly binaryName: string

  /**
   * Mount provider-side config artifacts (directories and/or files) into
   * the container. Optional — providers that are stateless on the host
   * (none today) leave this undefined or pass an empty array.
   *
   * Multiple entries support providers whose CLI splits state across more
   * than one path (e.g. Claude needs both `~/.claude/` for the dotfile dir
   * and `~/.claude.json` for the main config file). Order is preserved
   * but mounts are independent — if two entries overlap, Docker resolves
   * them in declaration order.
   */
  readonly configMounts?: readonly SandboxConfigMount[]

  /**
   * Optional environment extras to inject into the container. Layered AFTER
   * the spawn-arg env so provider-specific overrides can win, but BEFORE
   * the user can override (the user-facing override is per-provider via
   * the host setting, not per-env-var).
   *
   * Most provider env is already on `SpawnArgs.env` from the backend's
   * spawn pipeline. Use this only when the SDK contract doesn't expose a
   * cleaner channel — e.g. forcing a CLI to disable telemetry inside the
   * sandbox even when the user has it on globally.
   */
  envExtras?(): Record<string, string>

  /**
   * Optional spawn-time setup hook. Runs once on the host before the
   * container starts and lets the provider produce per-session artifacts
   * (e.g. a sanitized `settings.json` with hooks stripped, a generated
   * MCP manifest) and mount them into the container alongside the static
   * {@link configMounts}.
   *
   * Returned `extraMounts` are appended to {@link configMounts} in
   * declaration order. The `cleanup` callback (if provided) is invoked
   * after the container exits so the provider can unlink temp files.
   *
   * Errors thrown here propagate as spawn failures — keep the work fast
   * and synchronous-friendly (file I/O, not network calls).
   */
  prepareSpawn?(
    ctx: SandboxSpawnContext
  ): SandboxSpawnSetup | Promise<SandboxSpawnSetup>
}

/**
 * Context passed to {@link SandboxApi.prepareSpawn}. Identifies the Jack
 * session and the project root being mounted at `/workspace`. Providers
 * use these to namespace temp files (one settings overlay per session)
 * and avoid collisions across concurrent sandbox sessions.
 */
export interface SandboxSpawnContext {
  /** Stable per-session id. Safe to embed in temp filenames. */
  readonly sessionId: string
  /** Absolute host path mounted at `/workspace` inside the container. */
  readonly projectPath: string
}

/**
 * Return value of {@link SandboxApi.prepareSpawn}. Both fields optional —
 * a no-op setup just returns `{}`.
 */
export interface SandboxSpawnSetup {
  /**
   * Mounts to merge with the provider's static {@link configMounts}.
   * Useful for overlaying generated files (e.g. a sanitized settings.json
   * mounted on top of a config-dir mount shadows the original entry).
   */
  readonly extraMounts?: readonly SandboxConfigMount[]
  /**
   * Optional teardown. Invoked once after the container exits, even if
   * the spawn fails after `prepareSpawn` resolved. Errors are logged but
   * not propagated — cleanup is best-effort.
   */
  cleanup?(): void | Promise<void>
}
