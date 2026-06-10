/**
 * Interactive-launch capability — build the command line that starts this
 * provider's **interactive CLI** (its real terminal TUI) for a session,
 * pre-loaded with the session's composed context.
 *
 * Why this exists (see ADR 0006 "Dual session engine"):
 *   - Jack's normal session path drives the provider via the structured
 *     stream-json control protocol ({@link AgentBackend.query}). That path is
 *     programmatic/headless — on Anthropic subscriptions (from 2026-06-15) it
 *     spends from the separate Agent SDK credit pool.
 *   - The interactive TUI, driven by a human typing in an embedded terminal,
 *     spends from the normal subscription limits. Running it inside Jack's
 *     embedded terminal is identical to running it in iTerm/Terminal.app —
 *     Jack only pre-fills the launch command from the agent/workspace config.
 *
 * This capability lets the host obtain that pre-filled command WITHOUT baking
 * any provider-specific flag knowledge into the host. The host composes the
 * neutral context it already builds for chat sessions (system-prompt append,
 * additional directories, MCP servers, model, permission mode, …) and hands it
 * here; the provider maps it to its own CLI flags and file formats.
 *
 * Optional + presence-based, like {@link DiagnosticsApi} / {@link
 * ProviderDefaultsApi}: a provider that omits the field does not support the
 * terminal engine, and the host hides the engine picker for it. No
 * `CapabilityMatrix` flag.
 *
 * NOT a backend: there is no control protocol, no `canUseTool`, no live
 * model/permission switching, no in-process (SDK-type) MCP. Permissions, plan
 * mode, and questions are handled by the human in the terminal. Live UI
 * signals (chat bubbles, tool cards, snapshots) are delivered out-of-band via
 * the provider's hook wiring — see {@link InteractiveHookSink}.
 */

/**
 * Where the launched interactive session should POST live lifecycle/event
 * data so the host can render a chat view alongside the terminal. The provider
 * wires this into its native hook mechanism (e.g. Claude Code HTTP hooks in a
 * managed settings file). Entirely optional: when the host omits it, the
 * provider builds a launch with no event reporting (bare terminal).
 *
 * The events are provider-native shapes; the host normalizes them. ToS-safe:
 * this reports *out* from a human-driven interactive session — it does not
 * automate input.
 */
export type InteractiveHookSink = {
  /** Absolute local URL the provider's hooks POST event JSON to. */
  url: string
  /**
   * Bearer token the provider must attach to each hook POST so the host can
   * reject spoofed posts. The host generates it per session.
   */
  token: string
}

/**
 * Neutral inputs the host hands to {@link InteractiveLaunchApi.build}. Every
 * field is provider-agnostic; the provider decides how (and whether) each maps
 * to its own CLI surface.
 */
export type InteractiveLaunchOptions = {
  /** Working directory for the session. */
  cwd: string
  /**
   * A host-owned scratch directory the provider MAY write temp files into
   * (materialized system prompt, MCP config, managed settings). Paths the
   * provider returns in {@link InteractiveLaunchSpec.files} should live under
   * here; the host writes them and cleans them up on session teardown.
   */
  scratchDir: string
  /**
   * Host-generated session id (UUID) the provider SHOULD force so the host
   * knows the transcript location immediately (no projects-dir discovery).
   * Claude maps this to `--session-id`.
   */
  sessionId: string
  /** Display name for the session (Claude: `--name`). */
  sessionName?: string
  /**
   * When set, resume an existing provider-side session instead of starting
   * fresh (Claude: `--resume`). Mutually exclusive with a fresh `sessionId`
   * in practice; the provider picks the right flag.
   */
  resumeSessionId?: string
  /** Model id/alias for the session (Claude: `--model`). */
  model?: string
  /** Initial permission mode (Claude: `--permission-mode`). */
  permissionMode?: string
  /**
   * The fully-composed system-prompt append (workspace context + knowledge +
   * transversal rules + agent-definition body) the host already builds for
   * chat sessions. The provider materializes it under `scratchDir` and
   * references it (Claude: `--append-system-prompt-file`) to avoid argv limits.
   */
  systemPromptAppend?: string
  /** Extra readable/writable roots (Claude: `--add-dir`, one per entry). */
  additionalDirectories?: string[]
  /**
   * External (process-transport) MCP servers — stdio/http/sse configs only.
   * In-process (SDK-type) servers are NOT included by the host: they ride the
   * control protocol, which the terminal engine does not have. The provider
   * writes these to a config file (Claude: `--mcp-config`).
   */
  mcpServers?: Record<string, unknown>
  /** Setting sources to load (Claude: `--setting-sources`, e.g. user,project,local). */
  settingSources?: string[]
  /** Extra environment variables to set on the process (e.g. profile config-dir var). */
  env?: Record<string, string>
  /** Where live hook events should be reported. See {@link InteractiveHookSink}. */
  hookSink?: InteractiveHookSink
}

/**
 * The launch command the host spawns in a PTY. Pure data (serializable on
 * purpose, so a thin out-of-app `jack <agent>` CLI can fetch it from the
 * running app over an endpoint and exec it without rebuilding anything).
 */
export type InteractiveLaunchSpec = {
  /** Executable to run (e.g. the resolved `claude` binary). */
  command: string
  /** Arguments, already including any provider-specific flags. */
  args: string[]
  /** Extra environment to merge into the child's env. */
  env?: Record<string, string>
  /** Working directory (normally echoes `opts.cwd`). */
  cwd: string
  /**
   * Files the host must write to disk before spawning, keyed by absolute path
   * (under `opts.scratchDir`). The provider references these paths in `args`
   * (e.g. the materialized system-prompt append, the MCP config JSON, the
   * managed settings file wiring hooks). Keeps file FORMAT + flag knowledge in
   * the provider while the host owns the actual fs writes and lifecycle.
   */
  files?: Array<{ path: string; content: string }>
}

/**
 * Interactive-launch API — optional capability on {@link JackProvider}.
 *
 * Synchronous and side-effect-free: `build` only assembles data. The host
 * performs the fs writes (from {@link InteractiveLaunchSpec.files}) and the
 * process spawn.
 */
export type InteractiveLaunchApi = {
  /** Assemble the launch spec for an interactive (TUI) session. */
  build(opts: InteractiveLaunchOptions): InteractiveLaunchSpec
}
