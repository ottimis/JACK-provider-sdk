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
 * Mount a provider-side config artifact (directory or file) into the
 * container. Most providers persist auth + sessions + per-user settings in
 * a dotfile dir under `$HOME` (Claude `~/.claude`, Codex `~/.codex`,
 * Gemini `~/.gemini`); some additionally need a sibling config file
 * mounted alongside (Claude `~/.claude.json` is a good example — the CLI
 * reads it as the "main config" separate from the dotfile dir). The host
 * mounts each entry into the container at {@link containerPath} so the CLI
 * inside the container has access to the same state as the host.
 *
 * Read-only is recommended whenever the provider's CLI doesn't genuinely
 * need to mutate state. Set `readOnly: false` when the CLI writes back —
 * Claude writes session-env, project history, MCP additions; Codex appends
 * thread JSONL; etc. The trade-off when RW is enabled: sandbox sessions
 * share the same on-disk state as the host CLI (history, project state,
 * MCP edits). If you need credential isolation, build a copy-on-write
 * scratch volume — the {@link SandboxApi} contract doesn't impose one.
 */
export type SandboxConfigMount = {
  /**
   * Absolute host path. Provider implementations resolve this lazily — call
   * `os.homedir()` + `path.join(...)` at the time `configMounts` is read,
   * not at module-load time, so test environments and per-process HOME
   * overrides work correctly. May point to either a directory or a single
   * file — Docker's bind mount accepts both.
   */
  hostPath: string
  /** Absolute container path. */
  containerPath: string
  /** When `true`, the host adds `:ro` to the bind. */
  readOnly: boolean
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
}
