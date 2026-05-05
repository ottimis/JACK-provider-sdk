/**
 * `@ottimis/jack-provider-sdk` — public surface for AI provider plugins.
 *
 * In-tree providers (Claude, Codex, Gemini) and any future external
 * package import every neutral type + primitive from here. The host
 * imports from here too so a provider package depends only on this SDK
 * (not on Jack's main process internals) and Jack stays free to evolve
 * its host code without breaking provider authors.
 *
 * Re-exports cover four layers:
 *   - `./backend` — neutral wire-shape contract (`AgentBackend`,
 *     `AgentQueryOptions`, `AgentSession`, …)
 *   - `./spawner` — process-spawning primitives shared by every backend
 *     (`ProcessSpawner`, `ProcessHandle`, `localSpawner`, …)
 *   - `./provider` — plugin-level contract (`JackProvider`,
 *     `CapabilityMatrix`, `ToolDescriptor`, `ProviderBranding`, …)
 *   - `./usage` — provider-owned billing/usage surface (`UsageApi`,
 *     `UsageMetric`, …)
 *   - `./host` — host primitives injected at activation
 *     (`HostServices`, `HostKvScope`, `HostAuthService`, …) — providers
 *     consume these via `JackProvider.activate(host)` instead of
 *     reaching into Electron / host internals directly.
 *
 * Companion runtime types from `@ottimis/jack-chat-core` (`NormalizedMessage`,
 * `ClientToolHandler`, `ToolShape`, …) are re-exported through `./provider`
 * so consumers don't need to import from chat-core directly when they only
 * need the canonical wire shapes.
 */

export * from './backend'
export * from './spawner'
export * from './provider'
export * from './usage'
export * from './host'

/**
 * Re-export of `NormalizedMessage` from chat-core so consumers don't need
 * to depend on it directly when their only entrypoint into the wire shape
 * is via `AgentBackend`. Mirrors the legacy
 * `src/main/agent/backend.ts` re-export.
 */
export type { NormalizedMessage } from '@ottimis/jack-chat-core'
