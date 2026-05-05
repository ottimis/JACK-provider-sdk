# Implementing a new provider

Task-oriented guide for adding a new `JackProvider` (in-tree or as an external `jack-<name>` package). Type reference: see the JSDoc in `src/provider.ts`, `src/backend.ts`, `src/spawner.ts`, `src/host.ts`, `src/usage.ts`. Host-side contract spec: [`docs/provider-package-spec.md`](https://github.com/ottimis/JACK/blob/main/docs/provider-package-spec.md) in the JACK repo.

This guide covers the **how**: what's needed, in what order, and which choices are non-obvious.

---

## 1. Choose the integration pattern

Before writing a single line, pick the integration pattern. It drives almost every other decision.

| Pattern | Examples | Key trait | What you implement |
|---|---|---|---|
| **A — Provider-driven** | Claude (SDK/CLI), Codex | The provider emits messages and *requests* tools from the host when needed | Backend translates wire ↔ `NormalizedMessage`. fs/terminal tools live inside the provider. |
| **B — Host-driven (ACP)** | Gemini (ACP) | The provider asks the host to execute fs/terminal/tools over JSON-RPC | Backend translates wire ↔ `NormalizedMessage` **and** you implement `attachClientToolHandler` to receive the host-injected handler. |

Rule of thumb: if the AI runtime exposes a protocol where *it* invokes read/write/exec on the client (ACP, MCP-style outward), you're in Pattern B. Otherwise A.

---

## 2. Package setup

### In-tree option

Create `providers/<name>/` inside the JACK monorepo and declare the workspace in `pnpm-workspace.yaml`. Nothing to publish.

### External option (`jack-<name>` on npm)

```jsonc
// package.json
{
  "name": "@yourscope/jack-<name>",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "peerDependencies": {
    "@ottimis/jack-provider-sdk": ">=0.5.0",
    "@ottimis/jack-chat-core": ">=0.5.5",
    "zod": ">=3.22.0"
  }
}
```

`zod` is a peer dep because `InProcessMcpToolSpec.schema` must type-check against the same instance the host uses. `@ottimis/jack-chat-core` is a peer because types like `NormalizedMessage` travel by reference.

Build dual ESM+CJS the same way the SDK does (see this repo's `package.json` for the three `build`/`tsc`/`tsc -p tsconfig.cjs.json` scripts).

---

## 3. Implementation checklist

Fill in **in this order** — each step assumes the previous ones are already defined.

### 3.1 `detect()` — the first useful step

```ts
async detect(): Promise<ProviderDetectResult> {
  const path = await which('myagent')
  if (!path) {
    return {
      installed: false,
      reason: 'myagent CLI not found in PATH',
      installCommand: 'npm install -g @vendor/myagent',
      docsUrl: 'https://docs.example.com/install'
    }
  }
  const authed = await checkCreds()
  return {
    installed: true,
    authenticated: authed,
    authReason: authed ? undefined : 'Credentials expired',
    signInCommand: 'myagent login'
  }
}
```

**Three states for `authenticated`**: `true` / `false` / omitted. Omit it when the provider doesn't model auth (e.g. self-contained SDK). Use `false` only when you can distinguish it from `true` with a quick check — never block startup on a slow probe.

### 3.2 `BackendDescriptor` + `AgentBackend`

One backend = one wire-protocol implementation. Most providers ship a single one.

```ts
const myBackend: AgentBackend = {
  name: 'sdk',
  query(input) {
    // 1. Spawn (use input.options.spawner ?? localSpawner — NEVER child_process.spawn directly)
    // 2. Wrap in an AgentSession exposing AsyncIterable<NormalizedMessage>
    // 3. Translate wire → NormalizedMessage on-the-fly
    // 4. Expose interrupt/close/getContextUsage/setPermissionMode/setModel/setEffortLevel/getSettings
    return session
  },
  listSessions: async (opts) => { /* read on-disk transcripts */ },
  renameSession: async (id, title) => { /* persist title */ },
  forkSession: async (id, opts) => { /* duplicate with optional cutoff */ }
}
```

**Common mistakes worth flagging**:
- Use `input.options.spawner` if present — that's the host injecting a Docker spawner for sandboxed sessions. Hardcoding `child_process.spawn` breaks sandboxing.
- `NormalizedMessage.raw` must be lossless. Don't normalize it away.
- `getContextUsage()` may return a loose bag; the chip lifts it through `provider.usage.formatSessionMetrics`.
- `setEffortLevel` and `setModel` accept `undefined` to mean "reset to default".
- `listSessions` typically sorts by `lastModified` desc, but it's not enforced — document your choice.

### 3.3 `CapabilityMatrix` — be honest

See the JSDoc on `CapabilityMatrix` for the full list. **Golden rule**: aspirational declarations produce broken UI. If you don't have a native `ExitPlanMode` primitive, set `planMode: false` — and don't include `'plan'` in `permissionModes`.

```ts
capabilities: {
  partialMessages: true,        // token-by-token streaming
  hooks: { PreToolUse: true, PostToolUse: true },
  planMode: false,              // no ExitPlanMode primitive
  askUserQuestion: false,
  subagents: 'none',            // 'native' | 'polyfill' | 'none'
  mcp: true,
  structuredPatch: false,       // Claude-only today
  resumeSession: true,
  liveModelSwitch: true,
  liveEffortSwitch: false,      // when effort is spawn-time only
  livePermissionModeSwitch: true,
  permissionGranularity: 'callback', // 'callback' | 'sandbox-only'
  usage: false,                 // true only if you implement UsageApi
  permissionModes: ['default', 'acceptEdits', 'bypassPermissions']
}
```

**Per-backend overrides**: if you ship multiple backends with different feature sets (Gemini stream-json vs ACP), declare the **lowest common denominator** at provider level and override deltas in `BackendDescriptor.capabilities`. Pattern A providers with wire-identical backends (Claude SDK and CLI) leave the descriptor's `capabilities` undefined.

### 3.4 `toolCatalog` + `parseToolName`

The renderer has three card types: bespoke, schema, generic.

```ts
toolCatalog: [
  { providerToolName: 'apply_patch', shape: 'fs.edit', cardStyle: 'bespoke' },
  { providerToolName: 'shell',       shape: 'terminal',  cardStyle: 'bespoke' },
  // MCP tools are dynamic → DO NOT list them here
]
```

`parseToolName` discriminates native vs MCP. Claude's convention is `mcp__<slug>__<tool>`; other providers declare their own:

```ts
parseToolName(raw) {
  if (raw.startsWith('mcp__')) {
    const [, slug, tool] = raw.split('__')
    return { kind: 'mcp', server: slug, toolName: tool }
  }
  return { kind: 'native', toolName: raw }
}
```

### 3.5 `applyKnowledgeContext` — fold the neutral context

The host merges workspace context + AgentDefinition knowledge + per-instance overrides into one `KnowledgeContext`. You fold it into the native shape:

```ts
applyKnowledgeContext(ctx, options) {
  // systemPromptAppend → the provider's SDK option
  options.systemPrompt = { type: 'preset', preset: 'default', append: ctx.systemPromptAppend }
  // directories → whatever the provider calls "additional roots", or sandbox mounts
  options.additionalDirectories = ctx.directories
  // mcpServers → map or config file
  options.mcpServers = ctx.mcpServers
}
```

If your provider uses a TOML config file instead of runtime options (Codex case), write the file from `prepareSpawnOptions` and leave this method essentially empty — but keep it defined so the host doesn't crash.

### 3.6 `readSessionTranscript` — on-disk replay

Replaces direct calls to the provider's SDK that used to be sprinkled across the host (indexer, mobile, IPC, name suggester). Contract:

- Return rows in **chronological order** (oldest first).
- Populate `messageId` whenever the source exposes one.
- Preserve `raw` verbatim.
- Return an empty array for sessions without a transcript.

### 3.7 (Optional) the rest

| Method | Implement when |
|---|---|
| `prepareSpawnOptions` | You need to write `providerSpawnHints` for packaged builds (e.g. asar-unpacked path). |
| `attachInProcessMcpServer` | Your SDK supports in-process MCP (Claude `createSdkMcpServer`). If not, omit it: the host degrades — pair-mode reviewers don't get Jack's tools. |
| `attachClientToolHandler` | **Pattern B only.** The host injects the handler at session start. Store the reference and use it when wire requests arrive for fs/terminal/tools. |
| `slashCommands` | You have a `/command` UX. Discriminate `builtins` / `scanCommands` / `subscribeToWireCommands` / `parseEnvelope`. |
| `persistedPermissions` | You persist permission rules on disk (Claude's `.claude/settings*.json`). Sandbox-only models (Codex) leave it undefined. |
| `usage` | You have a billing/quota endpoint. See `src/usage.ts` for `UsageApi`. The `usage` capability flag must reflect whether this field is present. |
| `activate(host)` | You need KV storage or auth flows. The host hands you `HostServices`, namespaced per provider. **Idempotent** — `activate` may be called twice. |
| `policies` | You have non-trivial rules about how the host should treat your content (user-content sanitization, etc.). |

### 3.8 `modelDefaults` + `branding` + `modelOptions` / `effortLevels`

```ts
modelDefaults: { oneShot: 'myagent-fast' },  // cheapest model, MUST be available on every account
branding: { accentColor: '#ff6b6b', iconKey: 'sparkles' },
modelOptions: [
  { value: 'myagent-pro', label: 'Pro' },
  { value: 'myagent-fast', label: 'Fast' }
],
effortLevels: ['low', 'medium', 'high']  // only when liveEffortSwitch: true
```

`oneShot` is what the host uses for cheap one-shot tasks (session-name suggester, agent-def hints). Don't hardcode a model that requires premium tiers.

---

## 4. Minimal example — Pattern A

A provider that spawns a CLI and parses stream-json.

```ts
// src/index.ts
import type {
  JackProvider,
  AgentBackend,
  AgentSession,
  NormalizedMessage
} from '@ottimis/jack-provider-sdk'
import { localSpawner } from '@ottimis/jack-provider-sdk'

const myBackend: AgentBackend = {
  name: 'cli',
  query({ prompt, options }) {
    const spawn = options.spawner ?? localSpawner
    const controller = new AbortController()
    const proc = spawn({
      command: 'myagent',
      args: ['--stream-json', '--cwd', options.cwd ?? process.cwd()],
      env: { ...process.env, ...options.env },
      signal: controller.signal
    })

    // Push prompt
    if (typeof prompt === 'string') {
      proc.stdin.write(JSON.stringify({ type: 'user', text: prompt }) + '\n')
    } else {
      // AsyncIterable: pump into stdin
      ;(async () => {
        for await (const turn of prompt) {
          proc.stdin.write(JSON.stringify({ type: 'user', text: turn }) + '\n')
        }
      })()
    }

    const session: AgentSession = {
      [Symbol.asyncIterator]: async function* () {
        for await (const line of readLines(proc.stdout)) {
          const wire = JSON.parse(line)
          yield translateToNormalized(wire) // your mapping
        }
      },
      async interrupt() { proc.kill('SIGINT') },
      close() { controller.abort() },
      async getContextUsage() { return { totalTokens: 0 } },
      async stopTask() { /* no-op when the provider doesn't separate tasks */ },
      async setPermissionMode(mode) { sendControl(proc, 'set_mode', { mode }) },
      async setModel(model) { sendControl(proc, 'set_model', { model }) },
      async setEffortLevel(effort) { /* throw 'UNSUPPORTED' if you don't have live switching */ },
      async getSettings() { return { effective: {}, sources: {} } }
    }
    return session
  },
  async listSessions() { return readTranscriptDir() },
  async renameSession(id, title) { writeTitleFile(id, title) },
  async forkSession(id, opts) { return { sessionId: copyTranscript(id, opts) } }
}

export const myProvider: JackProvider = {
  id: 'myagent',
  label: 'MyAgent',
  branding: { accentColor: '#ff6b6b', iconKey: 'sparkles' },
  async detect() {
    return { installed: true, authenticated: true }
  },
  backends: [{ id: 'cli', label: 'CLI', factory: () => myBackend }],
  defaultBackendId: 'cli',
  capabilities: {
    partialMessages: true,
    hooks: { PreToolUse: false, PostToolUse: false },
    planMode: false,
    askUserQuestion: false,
    subagents: 'none',
    mcp: true,
    structuredPatch: false,
    resumeSession: true,
    liveModelSwitch: true,
    liveEffortSwitch: false,
    livePermissionModeSwitch: true,
    permissionGranularity: 'sandbox-only',
    usage: false,
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions']
  },
  modelDefaults: { oneShot: 'myagent-fast' },
  toolCatalog: [
    { providerToolName: 'apply_patch', shape: 'fs.edit', cardStyle: 'bespoke' },
    { providerToolName: 'shell',       shape: 'terminal',  cardStyle: 'bespoke' }
  ],
  parseToolName: (raw) => ({ kind: 'native', toolName: raw }),
  applyKnowledgeContext(ctx, options) {
    options.systemPrompt = { type: 'preset', preset: 'default', append: ctx.systemPromptAppend }
    options.additionalDirectories = ctx.directories
    options.mcpServers = ctx.mcpServers
  },
  async readSessionTranscript(opts) {
    return loadJsonl(opts.providerSessionId, { limit: opts.limit, offset: opts.offset })
  }
}
```

---

## 5. Minimal example — Pattern B (ACP)

A provider that speaks bidirectional JSON-RPC: the agent asks the host for fs/terminal/tools.

```ts
import type {
  JackProvider,
  AgentBackend,
  ClientToolHandler,
  ClientToolHandlerAttachContext
} from '@ottimis/jack-provider-sdk'

// Per-spawn slot: the host injects the handler BEFORE query.
const handlerSlot = new Map<string, ClientToolHandler>()

const myAcpBackend: AgentBackend = {
  name: 'acp',
  query({ prompt, options }) {
    // ... spawn the process + JSON-RPC peer
    rpc.handle('fs/read_text_file', async (params) => {
      const handler = handlerSlot.get(currentSessionId)
      if (!handler) throw new Error('handler not attached')
      return handler.fs.readTextFile(params.path)
    })
    rpc.handle('terminal/create', async (params) => {
      const handler = handlerSlot.get(currentSessionId)
      return handler!.terminal.create(params)
    })
    // ... rest of the wiring
    return session
  },
  // listSessions / renameSession / forkSession as above
}

export const myAcpProvider: JackProvider = {
  id: 'myacp',
  label: 'MyACP',
  async detect() { /* ... */ },
  backends: [{ id: 'acp', label: 'ACP', factory: () => myAcpBackend }],
  defaultBackendId: 'acp',
  capabilities: { /* ... permissionGranularity: 'callback' */ },
  modelDefaults: { oneShot: 'fast-model' },
  toolCatalog: [],
  parseToolName: (raw) => ({ kind: 'native', toolName: raw }),
  applyKnowledgeContext(ctx, options) { /* ... */ },
  async readSessionTranscript() { return [] },

  // KEY: pattern B
  attachClientToolHandler(handler, ctx: ClientToolHandlerAttachContext) {
    handlerSlot.set(ctx.sessionId, handler)
  }
}
```

The handler (`fs.readTextFile`, `fs.writeTextFile`, `terminal.create`, `tools.invoke`, …) is injected by the host. You receive wire requests and route them through the handler. Clear the slot when the session closes.

---

## 6. Versioning and compatibility

- **Minor** bumps add optional fields to `JackProvider` / `CapabilityMatrix` / `ToolShape`. Nothing to do on the provider side.
- **Major** bumps rename or restructure required fields. Update the `@ottimis/jack-provider-sdk` peer-dep range in your `package.json` and any adapter code.
- The host declares the minimum supported SDK version. The plugin loader rejects packages whose range doesn't satisfy it.

Pin the peer dep with a conservative range (`>=0.5.0 <0.6.0`) until you've tested against the next version.

---

## 7. Final checklist

Before publishing / merging:

- [ ] `pnpm typecheck` clean against the target SDK version.
- [ ] `detect()` exercised across the three states (installed=true/auth=true, installed=true/auth=false, installed=false).
- [ ] `CapabilityMatrix` reflects **honestly** what the backend supports — no aspirational `true`s.
- [ ] `permissionModes` only contains modes that `setPermissionMode` accepts without throwing.
- [ ] `toolCatalog` covers tools with bespoke cards; the rest fall back to the generic renderer.
- [ ] `applyKnowledgeContext` is idempotent and doesn't break when `mcpServers` is empty.
- [ ] `readSessionTranscript` returns chronological order with `raw` lossless.
- [ ] For Pattern B: the handler is attached **before** the first wire request (no race).
- [ ] `modelDefaults.oneShot` is available on every account where the provider works.
- [ ] Dual ESM+CJS build produces `dist/` and `dist/cjs/` with `.d.ts` files.
- [ ] (External) `peerDependencies` pinned to compatible ranges.

---

## 8. What NOT to do

- **Do not import host-internal modules** (`electron`, `better-sqlite3`, host IPC). Whatever you need from the host arrives via `activate(host: HostServices)`.
- **Do not leak provider-native SDK types** past the backend boundary. The host should only see `NormalizedMessage` and friends.
- **Do not declare capabilities you can't honor**. The renderer will show dead UI affordances.
- **Do not hardcode `child_process.spawn`** — go through `options.spawner`.
- **Do not mutate `NormalizedMessage.raw`**. It's needed for debug and for lossless re-rendering.
- **Do not block in `activate`** on network or disk. It's fire-and-forget — defer the work to the methods that actually need it.
