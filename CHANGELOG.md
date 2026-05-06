# Changelog

All notable changes to `@ottimis/jack-provider-sdk` will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-05-05

### Added

`UsageApi` is now profile-aware. Providers that also declare `capabilities.profiles=true` can drive distinct account-level usage flows for each profile (work vs personal Claude accounts polled independently, isolated cookie storage and login partitions).

- `UsageApi.status(profileId?)` — query connection state for a specific profile.
- `UsageApi.connect(ctx, profileId?)` — bind credentials to a profile. Different profileIds MUST use isolated storage AND isolated login surfaces (e.g. distinct BrowserWindow cookie partitions for Claude) so two accounts can sign in side by side.
- `UsageApi.selectOption?(optionId, profileId?)` — same profile as the matching `connect()`.
- `UsageApi.disconnect(profileId?)` — drop credentials for the specified profile only.
- `UsageApi.fetch(profileId?)` — pull a fresh snapshot for the specified profile.

`formatSessionMetrics()` stays profile-agnostic — per-session metrics already derive from the live process's context tokens (pinned to the session's profile via `applyProfile` at spawn time).

Back-compat: `profileId` is optional everywhere. Providers without `capabilities.profiles=true` ignore it. Providers WITH profiles MUST resolve omission to their default profile (preserves hosts that don't yet thread profileId through).

No breaking changes — every signature change is purely optional-param additive.

## [0.6.0] — 2026-05-05

### Added

Multi-profile capability — multiple isolated config/identity dirs selectable per session. Lets a single Jack install drive distinct provider accounts (work / personal) without shell-alias dancing around `CLAUDE_CONFIG_DIR`.

- `ProfilesApi` interface on `JackProvider.profiles?` (optional). Surface:
  - `list()` — enumerate registered profiles (provider seeds a "Default" on first call to preserve the user's existing setup).
  - `create(input)` / `update(id, patch)` / `remove(id)` — registry CRUD.
  - `applyProfile(options, profileId)` — host calls this once per spawn after `applyKnowledgeContext` + `prepareSpawnOptions`; provider injects its native env var (Claude `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`, …) into `options.env`.
  - `probeProfile?(configDir)` — optional best-effort introspection so the UI can show "Connected as X" / "Empty profile" hints.
- `ProviderProfile`, `ProviderProfileProbe`, `CreateProfileInput` types for the registry contract.
- `CapabilityMatrix.profiles: boolean` — gates UI affordances. When `true`, `JackProvider.profiles` MUST be defined.

Storage: provider persists the profile *list* via `host.kv` (already scoped per provider id). Profile *content* (auth, sessions, agents, history) lives inside `configDir` on disk and is the runtime's concern — Jack never reads or writes inside `configDir`.

No breaking changes: every field is additive. Providers without profiles support set `capabilities.profiles = false` and omit the `profiles` field — host hides every related affordance.

## [0.4.0] — 2026-05-03

### Added

Provider-declared permission-mode catalog. The renderer's Shift-Tab cycle no longer hardcodes the Claude shape with one-off filters per provider — each provider declares which modes it supports.

- `CapabilityMatrix.permissionModes: readonly AgentPermissionMode[]` — provider lists supported modes in cycle order. Drives the renderer's Shift-Tab cycle and any provider-aware UI. Modes outside the catalog MAY still be accepted by `setPermissionMode()` (slash command, settings) — the catalog only governs UI affordances.
- `AgentPermissionMode` widened to an open string union with `'auto'` and `'dontAsk'` added as known literals (was a closed union of `'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'`). Existing literal types still satisfy the type — additive.

In-tree provider declarations:

- Claude: `['default', 'acceptEdits', 'plan', 'auto']`
- Codex: `['default', 'acceptEdits', 'bypassPermissions']` — no `'plan'` because Codex has no `ExitPlanMode` primitive; mapping `'plan'` to read-only sandbox was a misleading shortcut.
- Gemini: `['default', 'acceptEdits', 'plan', 'bypassPermissions']`

No breaking changes — every field is additive.

## [0.3.0] — 2026-05-03

### Added

Provider-owned usage / billing capability. Single source of truth model — host plumbs, never decodes.

- `UsageApi` interface on `JackProvider.usage?` (optional). Two surfaces:
  - `fetch()` for account-level snapshots (Claude cookie API for Pro/Max, OpenAI usage endpoints for Codex API key, Gemini Cloud Billing). Pulled by host poller on `recommendedPollIntervalSec` cadence.
  - `formatSessionMetrics(raw: AgentContextUsage)` for per-session metric translation. The host's manager already calls `backend.getContextUsage()` after every assistant message; this hook lifts the loose bag into canonical `UsageMetric[]` without the host trying to interpret provider-specific fields.
- `UsageMetric` discriminated union with three kinds:
  - `time_window` — rolling utilization on a clock boundary (Claude 5h/7d, Gemini daily req quota). Optional `used` / `limit` / `unit` carry raw counts when the provider exposes them; Claude's cookie API leaves them undefined.
  - `token_utilization` — count-based without time boundary (context window, lifetime tokens). Optional `max` for the no-cap analytics case.
  - `monthly_spend` — $ spent on a billing cycle. Only meaningful for API-key auth; subscription users have rolling-window quotas instead.
- `UsageStatus`, `UsageConnectResult`, `UsageConnectOption`, `UsageConnectContext`, `UsageSnapshot` types for the connect / status / fetch flow. The `'choose'` branch on `UsageConnectResult` covers multi-org / multi-project accounts (Claude's existing flow).
- `CapabilityMatrix.usage: boolean` flag — host hides the chip's bars and Connect affordance when `false`. Providers MUST declare it; absence of `provider.usage` AND `capabilities.usage: false` are the two halves of the same gate.

No breaking changes — every field is additive. In-tree providers without a usage surface set `usage: false` in their capability matrix and omit the `usage` key on the provider object; existing callers keep working.

## [0.2.0] — 2026-05-03

### Breaking

Pre-external-consumer audit identified seven type-system gaps that would have shipped as breaking changes once external provider packages existed. All addressed before any third-party consumes the SDK. Every in-tree provider (Claude, Codex, Gemini) was migrated in the same commit on the host side.

- **`AgentSession.applyFlagSettings(Record<string, unknown>)` removed.** Replace with `setEffortLevel(effort: AgentEffortLevel | undefined)`. Pair with the new capability flag `liveEffortSwitch: boolean` in `CapabilityMatrix` so the renderer can gate the inline Effort dropdown without try/catching a method that isn't there. Claude maps internally to its `apply_flag_settings({ effortLevel })`; Codex/Gemini declare `liveEffortSwitch: false`.
- **`PermissionRule` shape generalised.** `tool: string` and `pattern: string | null` were Claude's `Bash(npm install)` parse — leaked the grammar into the contract. Now: `raw: string` (required, source-of-truth for round-trip writes) plus `humanReadable?: { tool?, pattern? }` parse-hint. Providers with a different rule grammar populate just `raw`; the UI falls back to displaying `raw` when no parse hint is available.
- **`InProcessMcpToolSpec.schema` typed as `Record<string, ZodType>`.** `zod >= 3.22.0` is a new peer dep. The previous `Record<string, unknown>` was opaque and Claude's wrapper had to cast — error-prone if the host ever passes a non-zod schema. JSON-Schema-only providers translate internally before passing to this field.
- **`AgentMcpServerConfig = unknown` retired.** Use the typed `McpServerSpec` discriminated union (`stdio | http | sse`) — same shape as `KnowledgeMcpResolution`, kept as alias for backward-readability. End-to-end typed input + output for `applyKnowledgeContext`.
- **`SlashCommandDef` flat shape → discriminated union by `scope`.** Three arms:
  - `'builtin'` — agent runtime intercepts. No body/filePath.
  - `'wire'` (NEW) — agent pushes catalog over the wire (Gemini ACP `available_commands_update`). No body/filePath.
  - `'user' | 'project'` — file-sourced markdown commands. `body` + `filePath` required.
  Consumers narrow on `scope` before reading body/filePath. `SlashCommandScope` type added as the open-string union of valid scope values.
- **`attachClientToolHandler` ctx is now required + named.** Type: `ClientToolHandlerAttachContext = { sessionId: string; actorId?: string }`. `jackSessionId` → `sessionId` (drop the brand prefix). The `actorId` slot is reserved for the future team-tier multi-user mode.
- **`CapabilityMatrix.permissionGranularity` widened.** Was `'callback' | 'sandbox-only'`; now `'callback' | 'sandbox-only' | 'hybrid' | (string & {})`. Mirrors the `BackendName` open-string pattern. Renderer falls back to a generic tooltip for unknown values.
- **`ProviderBranding.iconKey` typed.** Was free `string`; now `ProviderIconKey` curated hybrid enum (`'sparkles' | 'cpu' | 'gem' | 'bot' | 'brain' | 'star' | 'wand' | 'zap' | (string & {})`). Renderer falls back to default icon for unknown keys.

### Added

- `setEffortLevel`, `liveEffortSwitch`, `McpServerSpec`, `ClientToolHandlerAttachContext`, `SlashCommandScope`, `PermissionRuleHumanReadable`, `ProviderIconKey` exports.
- `zod >= 3.22.0` peer dependency.

### Tests

- Surface test count grew from 6 → 20. Every named export is referenced at least once so the barrel can't silently drop a name without a CI catch.

### Migration notes (consumer one-liner)

```diff
- session.applyFlagSettings({ effortLevel: x })
+ session.setEffortLevel(x)

- import type { AgentMcpServerConfig } from '@ottimis/jack-provider-sdk'
+ import type { McpServerSpec } from '@ottimis/jack-provider-sdk'

- attachClientToolHandler(handler, { jackSessionId: id })
+ attachClientToolHandler(handler, { sessionId: id })

- if (cmd.body) { … }                                // lies for builtin/wire
+ if (cmd.scope === 'user' || cmd.scope === 'project') { /* now cmd.body is typed */ }

- rule.tool                                           // string
+ rule.humanReadable?.tool                            // string | undefined

- schema: { input: z.string() } as Record<string, unknown>
+ schema: { input: z.string() }                       // typed
```

## [0.1.0] — 2026-05-03

Initial release. Three layers re-exported from the package root:

- `./backend` — neutral wire-shape contract (`AgentBackend`, `AgentQueryOptions`, `AgentSession`, `AgentPermissionMode`, `AgentEffortLevel`, `AgentHooks`, `BackendName` open string union, `AgentForkSessionOptions`, `AgentListSessionsOptions`).
- `./spawner` — process-spawning primitives (`ProcessSpawner`, `ProcessHandle`, `SpawnArgs`, `localSpawner`).
- `./provider` — plugin-level contract (`JackProvider`, `CapabilityMatrix`, `ToolDescriptor`, `ProviderBranding`, `ProviderModelOption`, `KnowledgeContext`, `SlashCommandSupport`, `PrepareSpawnContext`, `InProcessMcpServerSpec`, `PersistedPermissionsApi`, `ProviderDetectResult`, `BackendDescriptor`).

Source extracted from in-tree workspace package at `jack/packages/jack-provider-sdk`. Three providers (Claude, Codex, Gemini) implement the contract without coercion. Dual ESM/CJS publish pipeline mirrors `@ottimis/jack-chat-core`.
