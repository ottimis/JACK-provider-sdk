# Changelog

All notable changes to `@ottimis/jack-provider-sdk` will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
