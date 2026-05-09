/**
 * JackProvider — plugin contract for an AI provider integration.
 *
 * A provider package (in-tree `providers/claude/`, future external
 * `jack-codex`, `jack-gemini`, …) registers a single `JackProvider` object
 * that wires up everything the host needs to drive that AI:
 *
 *   - one or more {@link BackendDescriptor}s (the wire-protocol implementations)
 *   - a {@link CapabilityMatrix} so the UI knows what features to show
 *   - a {@link ToolDescriptor} catalog so the renderer can map provider-native
 *     tool names to canonical Jack shapes
 *   - a {@link JackProvider.detect} probe so the gate UI can warn when the
 *     host lacks a usable installation
 *
 * This file is the boundary between Jack core and a provider package — keep
 * it free of provider-specific imports.
 */

import type { AgentBackend, AgentPermissionMode, AgentQueryOptions, McpServerSpec } from './backend'
import type { HostServices } from './host'
import type { OneshotApi } from './oneshot'
import type { ProfilesApi } from './profiles'
import type { SandboxApi } from './sandbox'
import type { UsageApi } from './usage'
import type { ZodType } from 'zod'
import type {
  ClientToolHandler,
  NormalizedMessage,
  NormalizedToolRef,
  ProviderUserContentPolicy,
  ToolShape
} from '@ottimis/jack-chat-core'

export type ProviderId = string

/**
 * Where the provider sourced a slash command from. Drives the
 * {@link SlashCommandDef} discriminated union below — file-sourced
 * commands carry `body` + `filePath`, builtin and wire-sourced ones
 * don't (they don't *have* a markdown file behind them).
 */
export type SlashCommandScope =
  | 'builtin'
  | 'wire'
  | 'user'
  | 'project'
  | 'jack-builtin'
  | (string & {})

/**
 * Common surface every slash command def carries regardless of source.
 * The renderer uses these for autocomplete + chip rendering.
 */
type SlashCommandDefBase = {
  name: string
  description?: string
  argumentHint?: string
}

/**
 * Slash-command definition surfaced by a provider. Four sources can
 * coexist (see {@link SlashCommandSupport}):
 *
 *   - `'builtin'` — static catalog the runtime intercepts. The renderer
 *     never opens the file (there is none); the executor is the agent.
 *   - `'wire'` — pushed live by the agent over the wire (Gemini ACP
 *     `available_commands_update`). Same render contract as builtin —
 *     no on-disk artifact.
 *   - `'user' | 'project'` — file-based commands the user authored
 *     (Claude `.claude/commands/foo.md`, future per-provider analogs).
 *     `filePath` + `body` are required so the renderer can offer "open
 *     in editor" affordances and the host can expand `$ARGUMENTS` /
 *     `$N` placeholders.
 *   - `'jack-builtin'` — host-shipped slash command pack distributed
 *     inside the Jack app bundle (e.g. `/changelog-turn`,
 *     `/save-decision` for the user-data-tables feature). Read-only
 *     for the user (no edit/delete), expanded the same way as
 *     `'user'/'project'` (`$ARGUMENTS` + `$N` substitution). The body
 *     comes from `resources/slash-commands/builtin/<name>.md`; the
 *     renderer treats the catalog like any file-sourced command but
 *     hides authoring affordances behind the `readonly` flag.
 *
 * Discriminated by `scope` so consumers narrow before reading the
 * file-only fields. Replaces the legacy uniform shape that forced
 * builtin/wire commands to ship synthetic empty `body: ''` /
 * `filePath: ''`.
 */
export type SlashCommandDef =
  | (SlashCommandDefBase & { scope: 'builtin' })
  | (SlashCommandDefBase & { scope: 'wire' })
  | (SlashCommandDefBase & { scope: 'user' | 'project'; body: string; filePath: string })
  | (SlashCommandDefBase & { scope: 'jack-builtin'; body: string; readonly: true })

/**
 * Input shape for {@link SlashCommandSupport.createCommand}. The host
 * collects these fields from a dialog form and hands them verbatim to
 * the provider, which writes the markdown file in its native layout
 * (Claude: `~/.claude/commands/<name>.md` for user scope,
 * `<projectPath>/.claude/commands/<name>.md` for project).
 *
 * `name` may include subdirectory namespacing via `:` — e.g.
 * `git:review` → file at `git/review.md` under the scope root.
 * Provider validates the name (regex `[a-z][a-z0-9:-]*` typically) and
 * rejects with an error when the file already exists (caller decides
 * whether to retry with `overwrite`, omitted in v1 to avoid
 * accidental clobbering).
 */
export type CreateSlashCommandInput = {
  name: string
  scope: 'user' | 'project'
  description?: string
  argumentHint?: string
  body: string
  /** Required when `scope === 'project'`. */
  projectPath?: string
}

/**
 * Parsed envelope a provider's CLI may wrap slash commands in when it logs
 * them into the session transcript. Claude uses
 * `<command-name>foo</command-name><command-args>bar</command-args>` plus
 * an optional `<local-command-stdout>...</local-command-stdout>`.
 */
export type ParsedSlashEnvelope = {
  commandName: string
  commandArgs?: string
  commandStdout?: string
}

/**
 * Provider-declared slash-command support. Every field is optional so a
 * partial implementation degrades gracefully — e.g. a provider with
 * builtin commands but no envelope detection just declares
 * `builtins` and the host skips the envelope hook.
 */
export type SlashCommandSupport = {
  /** Static catalog of builtins the runtime intercepts. */
  builtins: SlashCommandDef[]
  /**
   * Scan host filesystem for user/project file-based commands. Returns
   * the catalog of file-based defs the user has authored locally. Empty
   * array when the provider doesn't support file-based commands.
   */
  scanCommands?(projectPath?: string): Promise<SlashCommandDef[]>
  /**
   * Detect the provider's slash envelope inside a user message text.
   * Return null when the text doesn't match — caller renders it as a
   * normal user bubble. Plumbed through `ReduceContext.parseSlashEnvelope`
   * to chat-core's reducer.
   */
  parseEnvelope?(text: string): ParsedSlashEnvelope | null
  /**
   * True when the message body is only CLI markers (e.g. Claude's
   * `<local-command-stdout>...</local-command-stdout>` blobs that show
   * up between turns). Used by `loadHistory` to drop noise from the
   * transcript. Plumbed through `ReduceContext.isCliMarkerOnly`.
   */
  isCliMarkerOnly?(text: string): boolean
  /**
   * Substitute the provider's argument placeholders in a file-based
   * command body. Claude uses `$N` (positional) and `$ARGUMENTS` (full
   * raw args). Other providers with file-based commands declare their
   * own substitution rule.
   */
  expandBody?(def: SlashCommandDef, rawArgs: string): string
  /**
   * Subscribe to wire-sourced slash command updates. Used by providers
   * that surface their command catalog dynamically over the wire instead
   * of (or in addition to) on-disk files — Gemini ACP emits a
   * `session/update { sessionUpdate: 'available_commands_update' }`
   * notification per session with the runtime command list.
   *
   * Contract:
   *   - The provider invokes the callback whenever the wire publishes a
   *     new catalog. The callback receives the FULL set (not a delta) so
   *     the host's command store can replace verbatim.
   *   - Returns an unsubscribe function. The host calls it on session
   *     close.
   *   - Optional. Providers without wire-driven commands (Claude file-
   *     based, Codex no-commands) leave it undefined and the host falls
   *     back to {@link builtins} + {@link scanCommands}.
   *
   * Wire-sourced commands COEXIST with `builtins` and `scanCommands` —
   * the host merges the three sets (wire takes precedence on name
   * collisions, since it reflects the agent's actual runtime state).
   */
  subscribeToWireCommands?(
    sessionId: string,
    callback: (commands: SlashCommandDef[]) => void
  ): () => void
  /**
   * Authoring: create a new file-sourced slash command on disk. Only
   * meaningful for providers that surface file-based commands (Claude
   * `.claude/commands/*.md`); providers without an on-disk format leave
   * this undefined and the host hides the "+ New" affordance.
   *
   * Contract:
   *   - Validates `input.name` against the provider's naming convention
   *     (typical regex: `[a-z][a-z0-9:-]*` with `:` for subdirectory
   *     namespacing).
   *   - Resolves the target file path under the scope root, creating
   *     intermediate directories as needed.
   *   - Refuses overwrite when the file already exists (throws an
   *     error with a stable code so the host can render a clear
   *     conflict message).
   *   - Writes frontmatter (`description`, `argument-hint`) plus the
   *     body verbatim. Returns the absolute file path.
   *
   * The host calls this from `provider:slash-commands:create` IPC and
   * the new file is picked up by {@link subscribeFsChanges} so the
   * renderer's palette refreshes without a manual reload.
   */
  createCommand?(input: CreateSlashCommandInput): Promise<{ filePath: string }>
  /**
   * Authoring: delete a file-sourced slash command. The host passes the
   * absolute `filePath` previously returned in a {@link SlashCommandDef}.
   * `projectPath` (when provided) lets the provider validate
   * project-scoped deletes too — without it, only files inside the user
   * root are accepted (delete-by-path on a project file requires the
   * caller to thread the project path through, which the host knows
   * from the active session's cwd).
   *
   * Contract:
   *   - Verifies that `filePath` is contained inside one of the provider's
   *     known scope roots (path normalisation + `path.relative()` check)
   *     to prevent the host from accidentally requesting deletion of a
   *     file outside the slash-commands tree.
   *   - Deletes the file. Idempotent: a missing file is treated as a
   *     successful no-op (no `ENOENT` thrown).
   *
   * Like {@link createCommand}, omitting this field hides the "Delete"
   * affordance for file-sourced rows in the renderer.
   */
  deleteCommand?(filePath: string, projectPath?: string): Promise<{ ok: true }>
  /**
   * Subscribe to filesystem changes in the provider's user/project
   * command roots. Distinct from {@link subscribeToWireCommands}: this
   * is fs-driven (markdown files added/edited/deleted on disk),
   * whereas the wire variant is provider-pushed runtime state.
   *
   * Contract:
   *   - The provider invokes the callback whenever a `.md` file under
   *     a known root is added, modified, or deleted (debounce is the
   *     provider's concern; the host treats the callback as "your
   *     cached list is stale, refetch").
   *   - The callback receives no payload — it's a stale-flag, not a
   *     diff. The host responds by re-running `scanCommands` and
   *     emitting `slashCommands:changed` to its renderers.
   *   - Returns an unsubscribe function. The host calls it on shutdown
   *     or provider switch.
   *   - Optional. Providers without a file-based source (Codex,
   *     Gemini today) leave this undefined and the host's cache is
   *     invalidated only on session boundary events.
   */
  subscribeFsChanges?(callback: () => void): () => void
}

/**
 * Options for {@link JackProvider.readSessionTranscript}. Provider-neutral
 * superset of what each backend supports — providers ignore fields they
 * can't honor (e.g. a remote-only provider with no on-disk replay).
 */
export type ReadSessionTranscriptOptions = {
  /** Provider-side conversation id (the value persisted in `sessions.provider_session_id`). REQUIRED. */
  providerSessionId: string
  /** cwd hint Claude needs to find the right `~/.claude/projects/<encoded>` dir. */
  cwd?: string
  /** Cap on the number of messages returned (caller decides head vs tail). */
  limit?: number
  /** Skip ahead N messages before reading (caller-driven pagination). */
  offset?: number
  /**
   * When true, include host-injected `system` rows (init, etc.). Default
   * false matches the existing behavior of the Claude SDK loader and the
   * current consumers.
   */
  includeSystemMessages?: boolean
}

/**
 * Provider-declared model identifiers used by host one-shot tasks. These
 * are the bits of "we need to ask the model something cheap and quick"
 * (session-name suggestion, agent-def suggestion, shared-template hint)
 * that previously hardcoded `claude-haiku-4-5` everywhere. Each provider
 * picks its own cheapest acceptable model.
 */
export type ProviderModelDefaults = {
  /**
   * Cheapest model the host should use for one-shot suggester tasks.
   * MUST be available on every account that has the provider installed —
   * suggesters degrade if the user can't access it.
   */
  oneShot: string
}

/**
 * One entry of the inline model dropdown rendered under the chat composer.
 * `value` is what gets passed to the provider's `/model` slash handler;
 * `label` is the short human display (e.g. `Sonnet`, `Pro`, `Flash`).
 */
export type ProviderModelOption = {
  value: string
  label: string
}

/**
 * Declarative rules a provider hands the host so the host knows *how* to
 * handle the provider's content — chat sanitization, future system-prompt
 * injection strategy, future tool-name detection hints.
 *
 * Today only `userContent` is wired; new namespaces are added as additional
 * optional fields without breaking external provider packages. The host
 * forwards the relevant slice to its consumer:
 *   - `userContent` → `provider.readSessionTranscript` (on-disk replay) +
 *     chat-core `ReduceContext.userContentPolicy` (live wire + history).
 *
 * Empty / undefined fields are no-ops.
 */
export type ProviderPolicies = {
  userContent?: ProviderUserContentPolicy
}

/**
 * Capabilities the UI gates on. Honest declaration > aspirational —
 * a provider that lies here will produce dead UI affordances.
 *
 * When you add a feature to Jack that depends on a provider primitive,
 * add a flag here so the corresponding renderer can opt out for providers
 * that don't support it.
 */
export type CapabilityMatrix = {
  /** Token-by-token assistant streaming (Claude `stream_event`). */
  partialMessages: boolean
  /** Hook events the provider can emit. */
  hooks: {
    PreToolUse: boolean
    PostToolUse: boolean
  }
  /** Native plan-mode primitive (Claude `ExitPlanMode`). */
  planMode: boolean
  /** Native question primitive (Claude `AskUserQuestion`). */
  askUserQuestion: boolean
  /** Subagent spawn: 'native' = provider has it, 'polyfill' = simulated, 'none' = absent. */
  subagents: 'native' | 'polyfill' | 'none'
  /** MCP (Model Context Protocol) server support. */
  mcp: boolean
  /** Claude-style structuredPatch in PostToolUse for fs.edit/fs.write. */
  structuredPatch: boolean
  /** Resume an existing session by id (preserves chat history across spawns). */
  resumeSession: boolean
  /** Switch model live without respawn (Claude control request `set_model`). */
  liveModelSwitch: boolean
  /**
   * Switch reasoning-effort tier live without respawn. Drives whether the
   * inline Effort dropdown fires `setEffortLevel()` (true) or requires a
   * spawn-time setting (false → dropdown hidden / annotated). Decoupled
   * from `liveModelSwitch` because Codex has live model but spawn-time
   * effort.
   */
  liveEffortSwitch: boolean
  /** Switch permission mode live without respawn. */
  livePermissionModeSwitch: boolean
  /**
   * Permission flow granularity.
   *
   *   - `'callback'` — the provider exposes a per-call canUseTool callback:
   *     each tool invocation can be blocked, modified, or auto-allowed
   *     before it fires (Claude). The renderer subscribes to the channel
   *     and the user sees every request.
   *   - `'sandbox-only'` — no per-call callback. The sandbox / approval
   *     policy is set at spawn time and the sandbox blocks violations as
   *     runtime errors; the model reads the error and self-corrects
   *     (Codex). The PermissionCard has no channel to subscribe to: the
   *     renderer hides it and only shows the post-fact audit log.
   */
  permissionGranularity: 'callback' | 'sandbox-only'
  /**
   * Provider exposes a usage / billing surface (account-level snapshot
   * via `provider.usage.fetch()` and/or per-session metric translation
   * via `formatSessionMetrics()`). When `false`, the chip hides the
   * usage bars and no Connect affordance is offered.
   */
  usage: boolean
  /**
   * Provider supports multiple isolated config/identity directories
   * ("profiles") — distinct accounts, login states, agent customizations,
   * and history sets all selectable per-session at runtime. When `true`,
   * {@link JackProvider.profiles} MUST be defined; the host renders the
   * profile picker UI and routes spawn-time `applyProfile` calls.
   *
   * When `false` the provider's runtime always uses its implicit default
   * config dir; the host hides every profile-related affordance.
   */
  profiles: boolean
  /**
   * Provider can run inside Jack's Docker sandbox. When `true`,
   * {@link JackProvider.sandbox} MUST be defined; the host enables the
   * sandbox toggle in the new-session dialog and renders an entry for this
   * provider in `Settings → Sandbox`.
   *
   * When `false` (or omitted), sandbox mode is unavailable for this
   * provider — the toggle is hidden / disabled in the UI, and a spawn-time
   * sandbox request returns a clear error.
   */
  sandbox: boolean
  /**
   * Provider exposes a non-agentic single-shot completion via
   * {@link JackProvider.oneshot}. When `false` the host hides any UI
   * affordance that depends on it (e.g. CommitComposer's "AI commit
   * message" button is disabled with an explanatory tooltip).
   *
   * When `true`, {@link JackProvider.oneshot} MUST be defined.
   */
  oneshot: boolean
  /**
   * Permission modes the provider actually supports. Drives the
   * Shift-Tab cycle in the renderer (`MessageInputBar`) and any
   * provider-aware UI that picks a mode (settings, slash commands).
   * Order matters — it's the cycle order on Shift-Tab.
   *
   * Each provider declares only the modes that have a meaningful
   * behaviour for its runtime: Claude's `['default', 'acceptEdits',
   * 'plan', 'auto']`, Codex's `['default', 'acceptEdits',
   * 'bypassPermissions']` (no `'plan'` because there's no ExitPlanMode
   * primitive — mapping `'plan'` to read-only sandbox would be
   * misleading), Gemini's set inherited from ACP `available_modes`.
   *
   * Modes outside this list MAY still be accepted by
   * `setPermissionMode()` (e.g. set programmatically via slash command
   * or settings); the catalog only governs UI affordances.
   */
  permissionModes: readonly AgentPermissionMode[]
  /**
   * Suggested prompt-cache TTL in milliseconds — how long the provider's
   * server-side prompt cache stays warm between user turns before a new
   * cache-write is required. Optional: providers without prompt caching
   * (or without a documented TTL) leave it undefined and the host hides
   * the cache-countdown chip entirely for sessions on that provider.
   *
   * This is only the **suggested default**: the user can override per
   * provider in `Settings → Prompt cache` and disable the chip outright.
   * The host treats this as a UI-only countdown hint — never as a
   * contract for actual cache eviction (the provider is the source of
   * truth at request time).
   *
   * Claude declares 300_000 (5 min) per its prompt-caching docs. Codex
   * and Gemini leave it undefined.
   */
  cacheTtlMs?: number
}

/**
 * Re-exports of canonical wire-shape types from chat-core so consumers of
 * this SDK get them at the same import path. Keeps `JackProvider` type
 * definitions self-contained in this package.
 */
export type { ToolShape }
export type {
  ClientToolHandler,
  ClientToolHandlerContext,
  ClientFsHandler,
  ClientTerminalHandler,
  ClientToolsHandler,
  TerminalSpec,
  TerminalHandle,
  TerminalOutput,
  RegisteredTool,
  ToolCallResult
} from '@ottimis/jack-chat-core'

export type ToolDescriptor = {
  /** Name as the provider emits it on the wire (e.g. 'Edit', 'apply_patch'). */
  providerToolName: string
  /** Canonical shape — the renderer keys off this. */
  shape: ToolShape
  /**
   * Hint for renderer / analytics card classification:
   *
   *   - `'bespoke'`: the renderer has a dedicated React card (Read,
   *     Write, Edit, Bash, apply_patch, …).
   *   - `'schema'`: the renderer uses SmartGenericRegistry to build a
   *     data-driven card (CronCreate, Skill, EnterPlanMode, …).
   *   - omitted = `'generic'` fallback (JSON renderer).
   *
   * MCP tools (`mcp__<slug>__<name>`) are classified separately via
   * `parseToolName` → kind=mcp and don't need this flag.
   */
  cardStyle?: 'bespoke' | 'schema'
}

/**
 * Probe result for {@link JackProvider.detect}. Used by the bootstrap
 * gate UI (`ProviderGate`) to decide whether to render the rest of the
 * app and, when missing or unauthenticated, what affordance to show
 * (install command, sign-in flow, docs link).
 *
 * On the `installed: true` branch, `authenticated` is an OPTIONAL
 * three-state signal:
 *   - `true`  → credentials present and probably valid
 *   - `false` → binary present, credentials missing or expired
 *   - omitted → provider doesn't model auth (e.g. SDK that's self-contained,
 *               or auth is implicit via the same install)
 */
export type ProviderDetectResult =
  | {
      installed: true
      /** Tri-state: true = creds present, false = creds missing/expired, undefined = N/A. */
      authenticated?: boolean
      /** Human-readable reason when `authenticated: false` (e.g. "OAuth token expired"). */
      authReason?: string
      /** Single-line command that authenticates (e.g. `claude login` / `codex login` / `gemini auth login`). */
      signInCommand?: string
      /** External docs URL for the auth flow when distinct from install docs. */
      authDocsUrl?: string
      details?: Record<string, unknown>
    }
  | {
      installed: false
      reason: string
      probedPaths?: string[]
      /** Single-line shell command that installs the missing runtime. */
      installCommand?: string
      /** External docs URL pointing at the canonical install guide. */
      docsUrl?: string
    }

/**
 * One backend = one wire-protocol implementation. A provider can ship
 * several (Claude: `sdk` bundles cli.js inside the asar, `cli` calls the
 * user's locally installed binary). Selection happens via
 * `JACK_AGENT_BACKEND` env var; default is `JackProvider.defaultBackendId`.
 *
 * `factory` is lazy so unused backends pay zero cost at boot.
 */
export type BackendDescriptor = {
  id: string
  label: string
  factory: () => AgentBackend
  /**
   * True when the backend ships its own runtime and doesn't depend on a
   * host install (e.g. Claude's `sdk` backend embeds `cli.js` inside the
   * asar). The bootstrap gate skips the install-missing screen when the
   * active backend is self-contained, regardless of `detect()` result.
   * Defaults to `false` for backends that drive a host-installed binary.
   */
  selfContained?: boolean
  /**
   * Backend-level capability overrides. When present, these take precedence
   * over the provider-level {@link CapabilityMatrix} for sessions running
   * on this backend. Provider-level remains the default for backends that
   * don't override.
   *
   * Use case: Gemini ships `cli` (stream-json) and `acp` (JSON-RPC)
   * transports with **different** feature sets — ACP exposes structured
   * plan, live model switch, callback-style permission gating; stream-json
   * has none. The provider declares the LCD at provider-level and ACP
   * overrides the deltas. Pattern A providers (Claude SDK/CLI are wire-
   * identical) typically don't need this and leave it undefined.
   */
  capabilities?: Partial<CapabilityMatrix>
}

/**
 * Context the host hands to {@link JackProvider.prepareSpawnOptions} so the
 * provider can decide what to wire (e.g. asar-unpacked CLI path in packaged
 * builds vs. a no-op in dev). Kept narrow on purpose — providers that need
 * more state should read it themselves.
 */
export type PrepareSpawnContext = {
  /** True in packaged builds (Electron `app.isPackaged`). */
  isPackaged: boolean
}

/**
 * MCP server registration in canonical wire-format shape. Same type
 * used at both ends of the knowledge pipeline: as
 * {@link KnowledgeContext.mcpServers} (input to the provider) and as
 * {@link AgentQueryOptions.mcpServers} (output from
 * {@link JackProvider.applyKnowledgeContext}). Each provider's
 * applyKnowledgeContext translates the merged context into its native
 * runtime layout (Claude SDK `mcpServers` map; Codex `mcp_servers.toml`;
 * Gemini ACP `session/new { mcpServers }`).
 *
 * Re-exported as `McpServerSpec` from `./backend` — same type, two names
 * for ergonomics in different code paths.
 */
export type KnowledgeMcpResolution = McpServerSpec

/**
 * Provider-neutral container for everything the host has computed about the
 * agent's working context: the system prompt addendum (markdown), the extra
 * working directories, and any MCP server registrations resolved from
 * `kind=mcp` knowledge sources.
 *
 * The host merges multiple KnowledgeContexts (workspace context +
 * AgentDefinition knowledge + per-instance overrides) into one before
 * handing it to {@link JackProvider.applyKnowledgeContext}, which folds it
 * into the provider's native {@link AgentQueryOptions} shape.
 */
export type KnowledgeContext = {
  /**
   * Markdown block to append to the agent's system prompt. Already formatted
   * — providers can either embed it verbatim (Claude `systemPrompt.append`)
   * or split it across system / first-user message (other providers).
   */
  systemPromptAppend: string
  /** Absolute paths the agent should treat as part of its working set. */
  directories: string[]
  /** Resolved MCP server registrations keyed by slug. */
  mcpServers: Record<string, KnowledgeMcpResolution>
}

/**
 * Visual identity declared by each provider. The host surfaces it in the
 * chat composer + sidebar so the user sees which provider is driving a
 * session at a glance.
 *
 * Lightweight by design — providers shouldn't need to ship images or
 * elaborate themes. Renderer treats `accentColor` as a CSS color (any
 * format CSS accepts) and `iconKey` as an enum of curated lucide icon
 * names the renderer maps to React components. Providers that don't
 * declare branding fall back to neutral defaults.
 */
/**
 * Curated icon catalog keys the renderer knows how to map to lucide React
 * components. Hybrid closed/open: well-known values get autocomplete;
 * arbitrary strings still type-check (the renderer falls back to a default
 * icon for unknown keys, so a provider can ship a forward-looking key
 * without breaking older hosts).
 */
export type ProviderIconKey =
  | 'sparkles'
  | 'cpu'
  | 'gem'
  | 'bot'
  | 'brain'
  | 'star'
  | 'wand'
  | 'zap'
  | (string & {})

export type ProviderBranding = {
  /**
   * Primary accent color. Used as a subtle border on the chat composer +
   * a small dot/icon next to the provider name in sidebar entries.
   * Format: any valid CSS color (`#ff6b6b`, `oklch(...)`).
   *
   * Choose a color with enough contrast on both light + dark themes
   * (~50% lightness works). The renderer applies it at low opacity for
   * borders so vivid hex codes are fine.
   */
  accentColor: string
  /**
   * Curated icon key — one of {@link ProviderIconKey}. Keeping this a
   * closed/open enum (instead of free-form SVG/asset) means providers
   * don't ship rendering assets and the host stays in control of what
   * shapes can land in the UI. Unknown keys fall back to a default icon
   * in the renderer.
   */
  iconKey?: ProviderIconKey
}

export type JackProvider = {
  id: ProviderId
  label: string
  /**
   * Visual identity (accent color + icon) the renderer can use to mark
   * which provider drives a session. Optional; renderer falls back to
   * neutral host theme when absent.
   */
  branding?: ProviderBranding
  /**
   * Probe the host to see if the provider is usable (binary installed,
   * credentials present, …). Surface result in the bootstrap gate.
   */
  detect(): Promise<ProviderDetectResult>
  backends: BackendDescriptor[]
  /** Must match one of `backends[].id`. Used when no env override is set. */
  defaultBackendId: string
  capabilities: CapabilityMatrix
  /**
   * Declarative rules that tell the host how to interpret this provider's
   * data. Distinct from {@link CapabilityMatrix} (what the provider CAN do
   * — drives UI gating) — `policies` say *how* the host should handle
   * content the provider emits or persists. Provider authors declare them
   * statically; the host consumes them at well-defined entry points
   * (`readSessionTranscript`, chat-core reducer via ReduceContext, …).
   *
   * Optional everywhere: a provider that doesn't need any rule simply
   * omits the field. New rule namespaces grow {@link ProviderPolicies}
   * without breaking existing providers.
   */
  policies?: ProviderPolicies
  /**
   * Default model identifiers for host one-shot tasks. Read by suggester
   * call sites (session naming, agent-def hint, shared-template hint) so
   * they don't hardcode a Claude-specific model.
   */
  modelDefaults: ProviderModelDefaults
  /**
   * Options surfaced in the inline Model dropdown under the chat composer.
   * Empty / omitted = no Model dropdown rendered (regardless of
   * `liveModelSwitch`). Selection fires the provider's `/model <value>`
   * slash handler. Hardcoded list is fine for providers with a fixed
   * family (Claude: opus/sonnet/haiku); providers whose available models
   * are dynamic per-session (Gemini's `availableModels[]`) leave this
   * empty until a per-session push lands.
   */
  modelOptions?: readonly ProviderModelOption[]
  /**
   * Reasoning-effort tiers surfaced in the inline Effort dropdown.
   * Empty / omitted = no Effort dropdown rendered. Selection fires the
   * provider's `/effort <value>` slash handler. Only Claude exposes
   * effort tiers as a live switch; other providers (Codex via
   * spawn-time, Gemini not at all) leave this empty.
   */
  effortLevels?: readonly string[]
  /**
   * Tools the provider surfaces in `tool_use` messages, with their
   * canonical shape. Tools not listed fall back to the generic renderer.
   * The `mcp__` prefixed tools are dynamic and resolved at runtime, not
   * declared here.
   */
  toolCatalog: ToolDescriptor[]
  /**
   * Optional hook called by the host right before each `backend.query()`
   * so the provider can wire packaging-specific spawn details (e.g.
   * Claude's SDK backend pointing at an asar-unpacked `cli.js` and the
   * macOS Electron Helper). Mutate `options` in place. Called once per
   * spawn, after the host has already populated `cwd`, `mcpServers`,
   * knowledge context, and any sandbox `spawner`. No-op for providers
   * that don't need it (CLI-only, dev-only, …).
   */
  prepareSpawnOptions?(options: AgentQueryOptions, ctx: PrepareSpawnContext): void
  /**
   * Parse a wire tool name into a {@link NormalizedToolRef}. Each provider
   * owns its own naming convention (Claude: `mcp__<slug>__<tool>` for MCP,
   * literal name for native; Codex: `apply_patch` style; …). The host
   * calls this whenever it needs to reason about a tool name without
   * committing to a specific provider's format — e.g. detecting Jack's
   * own MCP tools, MCP card classification, audit logs.
   */
  parseToolName(rawName: string): NormalizedToolRef
  /**
   * Optional slash-command support. Providers that surface a `/command`
   * UX (Claude's `.claude/commands/`, the `<command-name>` envelope in
   * transcripts, etc.) declare it here; providers without any slash
   * convention (Codex, Gemini, …) leave it undefined and the renderer
   * hides the slash autocomplete + skips envelope detection.
   */
  slashCommands?: SlashCommandSupport
  /**
   * Fold a provider-neutral {@link KnowledgeContext} into the provider's
   * native {@link AgentQueryOptions} shape. Mutates `options` in place.
   *
   * Claude maps the three fields onto SDK options:
   *   - `systemPromptAppend` → `systemPrompt.append`
   *   - `directories` → `additionalDirectories`
   *   - `mcpServers` → `mcpServers`
   *
   * Other providers may package the same data differently (e.g. Codex
   * inlines MCP into a config TOML and treats `directories` as sandbox
   * mount points). Called once per spawn, after the host has merged
   * workspace context + AgentDefinition knowledge + per-instance
   * overrides into a single {@link KnowledgeContext}.
   */
  applyKnowledgeContext(context: KnowledgeContext, options: AgentQueryOptions): void
  /**
   * Read a session's persisted transcript and return it as
   * {@link NormalizedMessage}[]. Replaces direct `getSessionMessages`
   * calls sprinkled across the host (indexer, mobile routes, IPC, name
   * suggester) — those used to import from the Claude SDK and would
   * crash for any other provider. Now they go through this hook.
   *
   * Implementations MUST:
   *   - return rows in chronological order (oldest first)
   *   - populate `messageId` on every message that has one in the source
   *     (Claude JSONL `uuid` → top-level `messageId`)
   *   - preserve `raw` verbatim (lossless)
   *
   * Returns an empty array when the session has no transcript yet (e.g.
   * fresh row, never sent a turn).
   */
  readSessionTranscript(opts: ReadSessionTranscriptOptions): Promise<NormalizedMessage[]>
  /**
   * Attach an in-process MCP server to the spawn options. Used by the
   * host to expose Jack-specific tools to the agent (e.g. partner
   * transcript reader for reviewer/tester slots in pair mode) without
   * going through an external MCP process.
   *
   * Provider-neutral spec: the host hands name/version + tool list, the
   * provider wraps them into whatever shape its SDK accepts. Optional —
   * providers without an in-process MCP API simply omit this method, and
   * the host quietly degrades (the agent doesn't get the Jack tools).
   *
   * Claude wraps via `createSdkMcpServer` + `tool` from the agent SDK.
   * Codex SDK has no in-process MCP — global `codex mcp add` only — so
   * `codexProvider` leaves this undefined and pair-mode reviewers
   * running on Codex don't get `get_partner_transcript`. Documented
   * limitation.
   */
  attachInProcessMcpServer?(
    options: AgentQueryOptions,
    spec: InProcessMcpServerSpec
  ): void
  /**
   * Pattern B (ACP-speaking providers like jack-gemini): the host injects
   * a {@link ClientToolHandler} the provider invokes for fs/terminal/tools
   * execution requested by the agent over JSON-RPC. The provider stores
   * the reference and routes ACP `fs/*`, `terminal/*`, `tools/*` requests
   * through it instead of calling `node:fs` / `node-pty` directly.
   *
   * Pattern A providers (Claude, Codex) leave this undefined; the host
   * detects the pattern by absence and skips wiring.
   */
  attachClientToolHandler?(
    handler: ClientToolHandler,
    ctx: ClientToolHandlerAttachContext
  ): void
  /**
   * Persisted permission rules manager. The host's
   * `permissions:{list,add,remove}` IPC dispatches through this — providers
   * that don't persist permission rules (sandbox-only models like Codex)
   * leave it undefined and the host returns empty snapshots.
   */
  persistedPermissions?: PersistedPermissionsApi
  /**
   * Usage / billing capability — provider-owned data flow. See
   * {@link UsageApi}. Optional; when undefined the chip degrades to
   * showing nothing (and `capabilities.usage` MUST be `false`). The
   * provider stays the single source of truth: host plumbs, never
   * decodes.
   */
  usage?: UsageApi
  /**
   * Multi-profile capability — multiple isolated config/identity dirs
   * selectable per session. See {@link ProfilesApi}. Optional; when
   * undefined `capabilities.profiles` MUST be `false` and the host hides
   * every profile-related affordance. When defined, the host calls
   * `applyProfile(options, profileId)` once per spawn so the provider can
   * inject its native config-dir env var (Claude `CLAUDE_CONFIG_DIR`,
   * Codex `CODEX_HOME`, …).
   */
  profiles?: ProfilesApi
  /**
   * Docker sandbox capability — provider declares the image, binary name,
   * and config-dir mount the host needs to spawn a sandboxed session for
   * this provider. See {@link SandboxApi}. Optional; when undefined
   * `capabilities.sandbox` MUST be `false` and the host disables sandbox
   * mode for this provider's sessions.
   */
  sandbox?: SandboxApi
  /**
   * One-shot completion capability — non-agentic, no tools, no session.
   * See {@link OneshotApi}. Optional; when undefined `capabilities.oneshot`
   * MUST be `false` and the host disables any UI affordance that relies
   * on this primitive (e.g. CommitComposer's AI commit message button).
   */
  oneshot?: OneshotApi
  /**
   * Optional one-shot activation hook. Called once by the host during
   * registration with a {@link HostServices} bag scoped to this
   * provider's id (kv namespace, auth partition prefix). Providers that
   * need host-side primitives (encrypted credential storage, child auth
   * windows, …) store the `host` reference and use it lazily; providers
   * that are pure (Codex, Gemini today) leave this undefined.
   *
   * Activation MUST be idempotent: calling `activate(host)` twice with
   * the same host is allowed and should not duplicate state. Activation
   * happens at registration time — well before any session spawns —
   * but providers MUST NOT block on network or disk here. Defer all I/O
   * to the methods that actually need it.
   *
   * The host calls `activate` synchronously enough that
   * `provider.usage`, `provider.persistedPermissions`, etc. can read
   * `host` from a closure / captured variable in subsequent invocations.
   * Async work inside `activate` is OK but the host won't await it
   * before exposing the provider — it's "fire and let it complete".
   */
  activate?(host: HostServices): void | Promise<void>
}

/**
 * Provider-neutral spec for an in-process MCP server the host wants to
 * expose to the agent. Each tool carries a zod schema for argument
 * validation + an async handler that produces MCP `content` blocks.
 *
 * Mirrors the surface of Claude's `tool()` factory but stays SDK-free
 * here so non-Claude providers can implement
 * {@link JackProvider.attachInProcessMcpServer} without dragging in
 * `@anthropic-ai/claude-agent-sdk`.
 */
export type InProcessMcpServerSpec = {
  name: string
  version: string
  tools: InProcessMcpToolSpec[]
}

/**
 * Context the host hands to {@link JackProvider.attachClientToolHandler}
 * so the provider can bridge wire-driven side channels back to the host
 * (e.g. mapping Gemini's `available_commands_update` notifications to
 * the renderer's per-session slash command store).
 *
 * Today only `sessionId` is consumed. `actorId` is reserved for the
 * future team-tier multi-user mode (north-star: every entity carries an
 * actor id so coordination scales beyond single-user). Adding a new
 * required field here would be a major bump; new optional fields ride
 * on a minor.
 */
export type ClientToolHandlerAttachContext = {
  /**
   * Host correlation id for the session being spawned. Required —
   * the provider stores it on its per-spawn slot so wire notifications
   * can route back to the right host-side consumer.
   */
  sessionId: string
  /**
   * Actor identity placeholder for future multi-user / team-tier
   * support. Today the host always passes `'self'` (or omits) since
   * Jack runs single-user; future remote-agent flows will populate
   * with `'user_xxx@team_yyy'` style strings.
   */
  actorId?: string
}

/**
 * Behaviour token the provider persists alongside each rule. Mirror of
 * Claude's `permissions.{allow,deny,ask}` arrays — providers with a
 * different vocabulary translate to/from this enum at their boundary.
 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask'

/**
 * Layer the rule lives in. The four-way split mirrors Claude's
 * user/userLocal/project/projectLocal settings cascade. Providers that
 * persist fewer layers populate only the relevant blocks; consumers see
 * empty arrays for the rest.
 */
export type PermissionSource = 'user' | 'userLocal' | 'project' | 'projectLocal'

/**
 * Optional human-readable parse hint for {@link PermissionRule}. Providers
 * whose rule grammar has a recognisable "tool" + "pattern" decomposition
 * (Claude's `Bash(npm install)`, `Edit(*.ts)`) populate this so the UI can
 * render two columns instead of a raw string. Providers with a different
 * grammar (Codex `approval_policy` keyed by command prefix) leave it
 * undefined; the UI falls back to displaying `raw`.
 */
export type PermissionRuleHumanReadable = {
  /** Best-effort tool name extracted by the provider (e.g. `Bash`, `Edit`). */
  tool?: string
  /** Best-effort pattern extracted by the provider (the bit inside the parens, etc.). */
  pattern?: string
}

/**
 * One persisted rule as the provider stores it. `raw` is the only
 * field guaranteed across providers — it's the source of truth for
 * round-trip writes (remove/add use the raw string verbatim) and the
 * fallback display when no parse hint is available. The
 * `humanReadable` sidecar is a Claude-style ergonomic split that
 * other providers may opt out of.
 */
export type PermissionRule = {
  /** Original string as stored by the provider — source of truth for round-trip writes. */
  raw: string
  /** Optional parse hint for two-column UI rendering. */
  humanReadable?: PermissionRuleHumanReadable
}

export type PermissionsSourceBlock = {
  source: PermissionSource
  /** Absolute path of the settings file (null if no project context was provided). */
  path: string | null
  /** True if the file currently exists on disk. */
  exists: boolean
  allow: PermissionRule[]
  deny: PermissionRule[]
  ask: PermissionRule[]
}

export type PermissionsSnapshot = {
  user: PermissionsSourceBlock
  userLocal: PermissionsSourceBlock
  project: PermissionsSourceBlock
  projectLocal: PermissionsSourceBlock
}

/**
 * Persisted permission rules manager — provider-declared, optional. The
 * host's `permissions:list/add/remove` IPC dispatches through the active
 * provider's implementation. Providers without a persisted permissions
 * model leave this undefined and the host returns empty snapshots.
 *
 * The neutral shape (four sources × three behaviours × `tool(pattern)`
 * rules) was generalised from Claude's `.claude/settings*.json` cascade
 * but stays generic enough for other providers' approval-policy stores.
 * A provider with a different vocabulary (e.g. Codex `approval_policy`
 * keyed by command prefix) translates inside this method.
 */
export type PersistedPermissionsApi = {
  list(projectPath?: string): PermissionsSnapshot
  remove(
    source: PermissionSource,
    behavior: PermissionBehavior,
    rawRule: string,
    projectPath?: string
  ): boolean
  add(
    source: PermissionSource,
    behavior: PermissionBehavior,
    rawRule: string,
    projectPath?: string
  ): boolean
}

export type InProcessMcpToolSpec = {
  name: string
  description: string
  /**
   * Zod schema for the tool arguments — a `Record<fieldName, ZodType>`
   * (zod's "shape" form, what `z.object(...)` accepts). Provider
   * implementations consume it via the SDK helper of their choice
   * (Claude wraps with `tool(name, desc, schema, handler)` from
   * `@anthropic-ai/claude-agent-sdk`).
   *
   * `zod` is a peer dep of this SDK so consumer + provider type-check
   * against the same instance. The host always produces zod; trying
   * to stuff JSON Schema here would silently break Claude's wrapper.
   */
  schema: Record<string, ZodType>
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
  }>
}
