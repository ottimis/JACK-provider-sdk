# `@ottimis/jack-provider-sdk`

Plugin contract for AI provider integrations in [Jack](https://github.com/ottimis/JACK). Every package that drives an AI coding agent inside Jack — `jack-claude`, `jack-codex`, `jack-gemini`, future `jack-<name>` — depends on this SDK and exports a single `JackProvider` object that satisfies the contract here.

## What's in the box

Three layers, all re-exported from the package root:

- **`./backend`** — neutral wire-shape contract: `AgentBackend`, `AgentQueryOptions`, `AgentSession`, `AgentPermissionMode`, `AgentEffortLevel`, `AgentHooks`, `BackendName` (open string union — `'sdk'`, `'cli'`, `'acp'`, …), `AgentForkSessionOptions`, `AgentListSessionsOptions`.
- **`./spawner`** — process-spawning primitives shared by every backend: `ProcessSpawner`, `ProcessHandle`, `SpawnArgs`, `localSpawner`. The host can swap `localSpawner` for a Docker variant (`createDockerSpawner()`) and providers won't notice.
- **`./provider`** — plugin-level contract: `JackProvider`, `CapabilityMatrix`, `ToolDescriptor`, `ProviderBranding`, `ProviderModelOption`, `ProviderModelDefaults`, `KnowledgeContext`, `KnowledgeMcpResolution`, `SlashCommandSupport`, `SlashCommandDef`, `PrepareSpawnContext`, `InProcessMcpServerSpec`, `PersistedPermissionsApi`, `ProviderDetectResult`, `BackendDescriptor`.

`NormalizedMessage` and other wire-shape canonicals are re-exported from `@ottimis/jack-chat-core` so consumers don't need a direct dep on chat-core when their only entrypoint is the wire shape.

## Install

```bash
pnpm add @ottimis/jack-provider-sdk @ottimis/jack-chat-core
```

`@ottimis/jack-chat-core` is a peer dep — pin a compatible version in your provider package.

## Implementing a `JackProvider`

```ts
import type { JackProvider } from '@ottimis/jack-provider-sdk'

export const myProvider: JackProvider = {
  id: 'my-agent',
  label: 'My Agent',
  branding: { accentColor: '#ff6b6b', iconKey: 'sparkles' },
  detect: async () => ({ installed: true }),
  backends: [{ id: 'sdk', label: 'SDK backend', factory: () => myBackend }],
  defaultBackendId: 'sdk',
  capabilities: { /* honest declaration — see CapabilityMatrix */ },
  modelDefaults: { oneShot: 'my-cheap-model' },
  toolCatalog: [/* ToolDescriptor[] */],
  parseToolName: (raw) => ({ kind: 'native', toolName: raw }),
  applyKnowledgeContext: (ctx, opts) => { /* fold into native opts */ },
  readSessionTranscript: async (opts) => { /* on-disk replay */ }
}
```

Full contract documented in the consumer repo: [`docs/provider-package-spec.md`](https://github.com/ottimis/JACK/blob/main/docs/provider-package-spec.md).

## Versioning

- **Minor** bumps add optional fields to `JackProvider` / `CapabilityMatrix` / `ToolShape`. Existing providers keep working.
- **Major** bumps rename or restructure required fields. Provider authors update their pinned range.

The host (Jack) declares the minimum SDK version it supports. The plugin loader (Phase 5 follow-up) rejects packages whose declared `peerDependencies.@ottimis/jack-provider-sdk` doesn't satisfy the host's range.

## Build & test

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` produces dual ESM (`dist/`) + CJS (`dist/cjs/`) output with declaration files. `dist/cjs/package.json` is auto-written with `{ "type": "commonjs" }` so Node resolves the right module format.
