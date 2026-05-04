/**
 * AgentBackend — abstraction that lets the host talk to an AI provider via
 * one of its concrete backends (Claude SDK / Claude CLI / Codex / Gemini ACP / …).
 *
 * Every type on this surface is **provider-neutral**: no SDK/Claude type
 * leaks past this boundary. Each provider package translates between its
 * native wire format and these neutral types inside the backend
 * implementation. The host never imports from a provider's native SDK
 * directly.
 *
 *   - The output stream is {@link NormalizedMessage} (parsed by the
 *     provider's translator).
 *   - The {@link AgentQueryOptions.canUseTool} callback receives a
 *     {@link NormalizedPermissionRequest} and resolves to a
 *     {@link NormalizedPermissionResult} — the provider does the wire
 *     translation on both sides.
 *   - The {@link AgentHooks} pipeline is fed {@link NormalizedHookEvent}s.
 *   - Provider-private spawn details (e.g. Claude SDK's `executable` +
 *     `pathToClaudeCodeExecutable`) ride in the
 *     {@link AgentQueryOptions.providerSpawnHints} escape hatch — the host
 *     populates them via `JackProvider.prepareSpawnOptions` and never
 *     inspects the contents.
 *
 * Selection happens in the host's `backendFactory` → which delegates to
 * the provider registry.
 */

import type { ProcessSpawner } from './spawner'
import type {
  NormalizedMessage,
  NormalizedPermissionRequest,
  NormalizedPermissionResult,
  NormalizedHookEvent
} from '@ottimis/jack-chat-core'

/**
 * Open string union — every provider declares its own backend ids. Today
 * `'sdk'` and `'cli'` are Claude-specific; Gemini ships `'acp'`. The host
 * resolves the active backend by id against the provider's `backends[]`
 * list, so widening to `string` is required for non-Claude providers.
 */
export type BackendName = string

// ─────────────────────────────────────────────────────────────────────────────
// Neutral option types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Permission gate behaviour. Open string union — providers declare which
 * subset they support via {@link CapabilityMatrix.permissionModes}, and
 * the host's permission-mode picker reads that catalog verbatim. Listed
 * literals are the modes any in-tree provider has shipped to date;
 * future providers may invent new strings without breaking the type.
 */
export type AgentPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'bypassPermissions'
  | 'dontAsk'
  | (string & {})

/** Settings layers the provider should consult at boot. */
export type AgentSettingSource = 'user' | 'project' | 'local'

/**
 * System prompt shape: a plain string (provider replaces its default), or
 * a preset envelope with an optional append (provider extends its default).
 * The preset name is provider-specific; today only `'claude_code'` exists.
 */
export type AgentSystemPrompt =
  | string
  | { type: 'preset'; preset: string; append?: string }

/**
 * MCP server configuration handed to the provider via
 * {@link AgentQueryOptions.mcpServers}. Mirrors the official MCP wire
 * format (the same shape Anthropic, OpenAI, and Google all consume).
 *
 * Replaces the legacy opaque `AgentMcpServerConfig = unknown` so the
 * type system enforces the contract end-to-end and the host can inspect
 * the bag for telemetry / preview without double-translating.
 */
export type McpServerSpec =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }

/** Reasoning-effort knob. Provider-validated; not all providers honor every value. */
export type AgentEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Hook handler — receives a normalized lifecycle event and may return an
 * opaque object the provider interprets (e.g. `{ continue: false }` to
 * abort a tool call). Most handlers just return `undefined`.
 */
export type AgentHookHandler = (event: NormalizedHookEvent) => Promise<unknown> | unknown

export type AgentHookMatcher = {
  /**
   * Glob over tool names. `'*'` matches every tool. Semantics provider-side
   * but every provider understands `'*'`.
   */
  matcher: string
  hooks: AgentHookHandler[]
  timeout?: number
}

export type AgentHooks = {
  preToolUse?: AgentHookMatcher[]
  postToolUse?: AgentHookMatcher[]
}

/**
 * Context window usage snapshot returned by {@link AgentSession.getContextUsage}.
 * Loose-typed because providers expose different breakdowns; the renderer
 * picks `totalTokens` / `maxTokens` / `percentage` and falls back to the
 * raw bag for advanced UI.
 */
export type AgentContextUsage = {
  total?: number
  totalTokens?: number
  maxTokens?: number
  rawMaxTokens?: number
  percentage?: number
  model?: string
  by_category?: Record<string, number>
  [k: string]: unknown
}

/**
 * Listing entry for `~/.claude/projects/<encoded>/<uuid>.jsonl` (or its
 * equivalent under future providers). Loose-typed: providers may expose
 * extra fields that the scanner just passes through.
 */
export type AgentSessionInfo = {
  sessionId: string
  cwd?: string
  summary?: string
  customTitle?: string | null
  firstPrompt?: string | null
  lastModified?: number
  createdAt?: number | null
  gitBranch?: string | null
  fileSize?: number
  [k: string]: unknown
}

/**
 * One turn of input the host pushes onto the prompt queue. Plain text today
 * — providers wrap it into their wire-native user-message envelope. When a
 * future host needs to push richer turns (e.g. images), this can grow into
 * a structured union without breaking the queue contract.
 */
export type AgentUserPrompt = string

// ─────────────────────────────────────────────────────────────────────────────
// Query options & input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options the host hands to {@link AgentBackend.query}. All fields are
 * neutral; provider-private extras live behind {@link providerSpawnHints}.
 */
export type AgentQueryOptions = {
  cwd?: string
  permissionMode?: AgentPermissionMode
  includePartialMessages?: boolean
  settingSources?: AgentSettingSource[]
  agentProgressSummaries?: boolean
  allowedTools?: string[]
  systemPrompt?: AgentSystemPrompt
  /**
   * Extra working directories beyond `cwd` that the agent can Read/Write
   * across. Populated via `JackProvider.applyKnowledgeContext` from the
   * merged KnowledgeContext (workspace tree + AgentDefinition `kind=dir`
   * knowledge sources).
   */
  additionalDirectories?: string[]
  mcpServers?: Record<string, McpServerSpec>
  resume?: string
  /**
   * Initial model for the spawn. Live switches use
   * {@link AgentSession.setModel}.
   */
  model?: string
  /**
   * Initial effort level for the spawn. Live switches use
   * {@link AgentSession.applyFlagSettings} with `{ effortLevel: ... }`.
   */
  effort?: AgentEffortLevel
  /**
   * Process spawner — decides how the provider's child process is launched.
   * Defaults to running locally. For sandboxed sessions, the host passes a
   * spawner created by `createDockerSpawner()`.
   */
  spawner?: ProcessSpawner
  /** Extra env vars merged into the spawned process environment. */
  env?: { [key: string]: string | undefined }
  /**
   * Provider-private spawn details. Populated by
   * `JackProvider.prepareSpawnOptions` and consumed by the matching backend
   * implementation. The host treats this bag as opaque — never read or
   * mutate the inner fields outside the provider package.
   *
   * Today the Claude provider stores `executable` and
   * `pathToClaudeCodeExecutable` here so the SDK backend can locate the
   * asar-unpacked `cli.js` + the macOS Electron Helper.
   */
  providerSpawnHints?: Record<string, unknown>
  /**
   * Permission gate. Receives a {@link NormalizedPermissionRequest} and
   * resolves to a {@link NormalizedPermissionResult}. Each provider's
   * backend translates between its wire format and these neutral shapes.
   */
  canUseTool?: (req: NormalizedPermissionRequest) => Promise<NormalizedPermissionResult>
  hooks?: AgentHooks
}

export type AgentQueryInput = {
  prompt: AgentUserPrompt | AsyncIterable<AgentUserPrompt>
  options: AgentQueryOptions
}

// ─────────────────────────────────────────────────────────────────────────────
// Session interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session-like object returned by backend.query(). Mirrors the subset of
 * the provider's runtime control surface that the host actually depends
 * on — intentionally narrow to keep backend implementations small.
 */
export interface AgentSession extends AsyncIterable<NormalizedMessage> {
  interrupt(): Promise<void>
  close(): void
  getContextUsage(): Promise<AgentContextUsage>
  stopTask(taskId: string): Promise<void>
  /**
   * Switch permission mode live, without respawning the child process.
   * Mirrors the CLI's Shift+Tab cycle (Claude provider).
   */
  setPermissionMode(mode: AgentPermissionMode | undefined): Promise<void>
  /**
   * Switch the model live. Pass `undefined` to clear any override and
   * fall back to the provider default.
   */
  setModel(model?: string): Promise<void>
  /**
   * Switch the reasoning-effort tier live, without respawning the child
   * process. Pass `undefined` to clear any override and let the provider
   * fall back to its default. Gated by `CapabilityMatrix.liveEffortSwitch`
   * — providers without live switching declare `false` and the renderer
   * hides the inline Effort dropdown.
   *
   * Replaces the legacy `applyFlagSettings({ effortLevel })` bag — Claude
   * was the only producer and Codex/Gemini both threw `UNSUPPORTED`. The
   * host now calls this method by name and the type system tells the
   * provider author exactly what to wire.
   */
  setEffortLevel(effort: AgentEffortLevel | undefined): Promise<void>
  /**
   * Read the effective runtime settings the provider booted with. Today
   * the host only consumes `effective.effortLevel` to populate the
   * Effort dropdown's initial value; the rest of the bag is opaque so
   * providers with richer settings layers can passthrough additional
   * keys without an SDK bump.
   */
  getSettings(): Promise<AgentSettingsResponse>
}

/**
 * Slimmed-down shape of the `get_settings` response. Providers may surface
 * hundreds of fields; we only look at the bits the host cares about and
 * keep the rest opaque.
 */
export type AgentSettingsResponse = {
  effective?: { effortLevel?: string; [key: string]: unknown }
  sources?: Record<string, unknown>
}

/** Options for backend.listSessions(). */
export type AgentListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
}

/** Options for backend.forkSession(). */
export type AgentForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}

export interface AgentBackend {
  readonly name: BackendName
  query(input: AgentQueryInput): AgentSession

  /**
   * List provider sessions on disk. Each backend reads its provider's
   * native transcript layout (`~/.claude/projects/...`,
   * `~/.codex/sessions/...`, `~/.gemini/tmp/.../chats/...`).
   */
  listSessions(opts?: AgentListSessionsOptions): Promise<AgentSessionInfo[]>

  /** Persist a custom title for a session. */
  renameSession(sessionId: string, title: string, opts?: { dir?: string }): Promise<void>

  /** Fork a session into a new one (optionally truncated at a cutoff message). */
  forkSession(
    sessionId: string,
    opts?: AgentForkSessionOptions
  ): Promise<{ sessionId: string }>
}
