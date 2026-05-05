# Implementare un nuovo provider

Guida task-oriented per aggiungere un nuovo `JackProvider` (in-tree o come pacchetto esterno `jack-<name>`). Riferimento ai tipi: vedi i JSDoc in `src/provider.ts`, `src/backend.ts`, `src/spawner.ts`, `src/host.ts`, `src/usage.ts`. Spec del contratto a livello host: [`docs/provider-package-spec.md`](https://github.com/ottimis/JACK/blob/main/docs/provider-package-spec.md) nel repo JACK.

Questa guida copre il **come**: cosa serve, in che ordine, quali scelte non sono ovvie.

---

## 1. Decidere il pattern

Prima di scrivere una riga di codice, scegli il pattern di integrazione. Influenza quasi tutto il resto.

| Pattern | Esempi | Caratteristica chiave | Cosa implementi |
|---|---|---|---|
| **A — Provider-driven** | Claude (SDK/CLI), Codex | Il provider emette messaggi e *chiede* eventuali tool al host quando serve | Backend traduce wire ↔ `NormalizedMessage`. Tool fs/terminal sono interni al provider. |
| **B — Host-driven (ACP)** | Gemini (ACP) | Il provider chiede al host di eseguire fs/terminal/tool via JSON-RPC | Backend traduce wire ↔ `NormalizedMessage` **e** implementi `attachClientToolHandler` per ricevere l'handler iniettato dal host. |

Regola: se la runtime AI espone un protocollo dove *lui* invoca read/write/exec sul client (ACP, MCP-style outward), sei in Pattern B. Altrimenti A.

---

## 2. Setup del pacchetto

### Opzione in-tree

Crea `providers/<name>/` nel monorepo JACK e dichiara il workspace nel `pnpm-workspace.yaml`. Niente da pubblicare.

### Opzione esterna (`jack-<name>` su npm)

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

`zod` è peer dep perché lo schema `InProcessMcpToolSpec.schema` deve type-checkare sulla stessa istanza del host. `@ottimis/jack-chat-core` è peer perché tipi come `NormalizedMessage` viaggiano per riferimento.

Build dual ESM+CJS come fa lo SDK stesso (vedi `package.json` di questo repo per i tre script `build`/`tsc`/`tsc -p tsconfig.cjs.json`).

---

## 3. Checklist di implementazione

Compila **in quest'ordine** — ogni step assume che i precedenti siano già definiti.

### 3.1 `detect()` — il primo step utile

```ts
async detect(): Promise<ProviderDetectResult> {
  const path = await which('myagent')
  if (!path) {
    return {
      installed: false,
      reason: 'myagent CLI non trovata nel PATH',
      installCommand: 'npm install -g @vendor/myagent',
      docsUrl: 'https://docs.example.com/install'
    }
  }
  const authed = await checkCreds()
  return {
    installed: true,
    authenticated: authed,
    authReason: authed ? undefined : 'Credenziali scadute',
    signInCommand: 'myagent login'
  }
}
```

**Tre stati di `authenticated`**: `true` / `false` / omesso. Ometti se il provider non modella auth (es. SDK self-contained). `false` solo se distinguibile da `true` con un check rapido — non bloccare lo start.

### 3.2 `BackendDescriptor` + `AgentBackend`

Un backend = una implementazione del wire-protocol. La maggior parte dei provider ne ha uno solo.

```ts
const myBackend: AgentBackend = {
  name: 'sdk',
  query(input) {
    // 1. Spawn (usa input.options.spawner ?? localSpawner — MAI child_process.spawn diretto)
    // 2. Wrappa in AgentSession con AsyncIterable<NormalizedMessage>
    // 3. Traduci wire → NormalizedMessage on-the-fly
    // 4. Esponi interrupt/close/getContextUsage/setPermissionMode/setModel/setEffortLevel/getSettings
    return session
  },
  listSessions: async (opts) => { /* leggi i transcript on-disk */ },
  renameSession: async (id, title) => { /* persisti */ },
  forkSession: async (id, opts) => { /* duplica con cutoff */ }
}
```

**Punti che si dimenticano sempre**:
- Usa `input.options.spawner` se presente — è il host che lo passa per sandbox Docker. Hardcodare `child_process.spawn` rompe la sandboxing.
- `NormalizedMessage.raw` deve essere lossless. Non normalizzare via.
- `getContextUsage()` può tornare un bag loose; il chip lo lifta via `provider.usage.formatSessionMetrics`.
- `setEffortLevel` e `setModel` accettano `undefined` per "reset al default".
- `listSessions` ordina per `lastModified` desc tipicamente, ma non è imposto — documenta cosa fai.

### 3.3 `CapabilityMatrix` — dichiarare onesto

Vedi i JSDoc di `CapabilityMatrix` per la lista completa. **La regola d'oro**: dichiarare aspirazionalmente produce UI rotta. Se non hai `ExitPlanMode` nativo, `planMode: false` — non includere `'plan'` in `permissionModes`.

```ts
capabilities: {
  partialMessages: true,        // streaming token-by-token
  hooks: { PreToolUse: true, PostToolUse: true },
  planMode: false,              // niente ExitPlanMode primitive
  askUserQuestion: false,
  subagents: 'none',            // 'native' | 'polyfill' | 'none'
  mcp: true,
  structuredPatch: false,       // solo Claude oggi
  resumeSession: true,
  liveModelSwitch: true,
  liveEffortSwitch: false,      // se l'effort è solo spawn-time
  livePermissionModeSwitch: true,
  permissionGranularity: 'callback', // 'callback' | 'sandbox-only'
  usage: false,                 // true solo se implementi UsageApi
  permissionModes: ['default', 'acceptEdits', 'bypassPermissions']
}
```

**Override per backend**: se hai più backend con feature set differenti (caso Gemini stream-json vs ACP), dichiari l'**LCD** a livello provider e gli override nel `BackendDescriptor.capabilities`. Pattern A con backend wire-identici (Claude SDK e CLI) lascia `capabilities` undefined nel descriptor.

### 3.4 `toolCatalog` + `parseToolName`

Il renderer ha tre tipi di card: bespoke, schema, generic.

```ts
toolCatalog: [
  { providerToolName: 'apply_patch', shape: 'fs.edit', cardStyle: 'bespoke' },
  { providerToolName: 'shell',       shape: 'terminal',  cardStyle: 'bespoke' },
  // tool MCP sono dinamici → NON elencarli qui
]
```

`parseToolName` discrimina nativi vs MCP. Convenzione di Claude `mcp__<slug>__<tool>`; altri provider dichiarano la propria:

```ts
parseToolName(raw) {
  if (raw.startsWith('mcp__')) {
    const [, slug, tool] = raw.split('__')
    return { kind: 'mcp', server: slug, toolName: tool }
  }
  return { kind: 'native', toolName: raw }
}
```

### 3.5 `applyKnowledgeContext` — fold del contesto neutro

Il host fonde workspace context + AgentDefinition knowledge + override → un `KnowledgeContext` solo. Tu lo pieghi nel formato nativo:

```ts
applyKnowledgeContext(ctx, options) {
  // systemPromptAppend → option SDK del provider
  options.systemPrompt = { type: 'preset', preset: 'default', append: ctx.systemPromptAppend }
  // directories → quello che il provider chiama "additional roots", o sandbox mounts
  options.additionalDirectories = ctx.directories
  // mcpServers → mappa o file di config
  options.mcpServers = ctx.mcpServers
}
```

Se il provider usa un file TOML invece di opzioni runtime (caso Codex), scrivi il file da `prepareSpawnOptions` e qui non fai nulla — ma lascia il metodo presente per non far crashare il host.

### 3.6 `readSessionTranscript` — replay on-disk

Sostituisce le call dirette al SDK del provider sparse nel host (indexer, mobile, IPC, suggester). Contratto:

- Ritorna **cronologico** (oldest first).
- Popola `messageId` quando la sorgente lo espone.
- Preserva `raw` verbatim.
- Empty array per sessioni senza transcript.

### 3.7 (Opzionali) il resto

| Metodo | Quando lo implementi |
|---|---|
| `prepareSpawnOptions` | Hai bisogno di scrivere `providerSpawnHints` per build packaged (es. asar-unpacked path). |
| `attachInProcessMcpServer` | Il SDK del provider supporta MCP in-process (Claude `createSdkMcpServer`). Se no, omettilo: il host degrada — pair-mode reviewers non ottengono i tool Jack. |
| `attachClientToolHandler` | **Pattern B only.** Il host ti inietta l'handler all'inizio della session. Salvi il riferimento e lo usi quando ricevi richieste fs/terminal/tools dal wire. |
| `slashCommands` | Hai una UX `/command`. Discrimina `builtins` / `scanCommands` / `subscribeToWireCommands` / `parseEnvelope`. |
| `persistedPermissions` | Persisti regole di permesso su disco (Claude `.claude/settings*.json`). Sandbox-only models (Codex) lasciano undefined. |
| `usage` | Hai un endpoint billing/quotas. Vedi `src/usage.ts` per `UsageApi`. La capability `usage` deve riflettere la presenza di questo campo. |
| `activate(host)` | Hai bisogno di KV storage o auth flows. Il host ti passa `HostServices` namespacati per provider. **Idempotente** — `activate` può essere chiamato due volte. |
| `policies` | Hai regole non-banali su come il host deve trattare il content (sanitization user content, etc.). |

### 3.8 `modelDefaults` + `branding` + `modelOptions` / `effortLevels`

```ts
modelDefaults: { oneShot: 'myagent-fast' },  // model più economico, deve essere SEMPRE disponibile
branding: { accentColor: '#ff6b6b', iconKey: 'sparkles' },
modelOptions: [
  { value: 'myagent-pro', label: 'Pro' },
  { value: 'myagent-fast', label: 'Fast' }
],
effortLevels: ['low', 'medium', 'high']  // solo se liveEffortSwitch: true
```

`oneShot` serve al host per task-cheap (suggester di nomi sessione, agent-def hints). Non hardcodare un model che richiede tier alti.

---

## 4. Esempio minimo — Pattern A

Provider che lancia un CLI e parsa stream-json.

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
      // AsyncIterable: pump verso stdin
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
          yield translateToNormalized(wire) // tua mappatura
        }
      },
      async interrupt() { proc.kill('SIGINT') },
      close() { controller.abort() },
      async getContextUsage() { return { totalTokens: 0 } },
      async stopTask() { /* no-op se il provider non distingue task */ },
      async setPermissionMode(mode) { sendControl(proc, 'set_mode', { mode }) },
      async setModel(model) { sendControl(proc, 'set_model', { model }) },
      async setEffortLevel(effort) { /* throw 'UNSUPPORTED' se non hai live switch */ },
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

## 5. Esempio minimo — Pattern B (ACP)

Provider che parla JSON-RPC bidirezionale: l'agente chiede al host fs/terminal/tools.

```ts
import type {
  JackProvider,
  AgentBackend,
  ClientToolHandler,
  ClientToolHandlerAttachContext
} from '@ottimis/jack-provider-sdk'

// Slot per spawn: il host inietta l'handler PRIMA della query.
const handlerSlot = new Map<string, ClientToolHandler>()

const myAcpBackend: AgentBackend = {
  name: 'acp',
  query({ prompt, options }) {
    // ... spawn del processo + JSON-RPC peer
    rpc.handle('fs/read_text_file', async (params) => {
      const handler = handlerSlot.get(currentSessionId)
      if (!handler) throw new Error('handler non collegato')
      return handler.fs.readTextFile(params.path)
    })
    rpc.handle('terminal/create', async (params) => {
      const handler = handlerSlot.get(currentSessionId)
      return handler!.terminal.create(params)
    })
    // ... resto del wiring
    return session
  },
  // listSessions / renameSession / forkSession come sopra
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

L'handler (`fs.readTextFile`, `fs.writeTextFile`, `terminal.create`, `tools.invoke`, ...) è iniettato dal host. Tu ricevi le richieste sul wire e le ruoti tramite l'handler. Quando la session si chiude, ripulisci lo slot.

---

## 6. Versionamento e compatibilità

- **Minor**: campi opzionali aggiunti a `JackProvider` / `CapabilityMatrix` / `ToolShape`. Niente da fare lato provider.
- **Major**: rinomi/restrutturazioni. Aggiorna il pin del peer `@ottimis/jack-provider-sdk` nel tuo `package.json` e l'eventuale codice di adattamento.
- Il host dichiara la versione minima supportata. Il loader rifiuta pacchetti il cui range non soddisfa.

Pin il peer dep con un range conservativo (`>=0.5.0 <0.6.0`) finché non hai testato la versione successiva.

---

## 7. Checklist finale

Prima di pubblicare / mergiare:

- [ ] `pnpm typecheck` pulito contro la versione di SDK target.
- [ ] `detect()` testata sui tre stati (installed=true/auth=true, installed=true/auth=false, installed=false).
- [ ] `CapabilityMatrix` riflette **fedelmente** ciò che il backend supporta — niente `true` aspirazionali.
- [ ] `permissionModes` contiene solo modi che `setPermissionMode` accetta senza throwing.
- [ ] `toolCatalog` copre i tool con card bespoke; gli altri cadono sul generico.
- [ ] `applyKnowledgeContext` è idempotente e non rompe se `mcpServers` è vuoto.
- [ ] `readSessionTranscript` ritorna in ordine cronologico, con `raw` lossless.
- [ ] Per Pattern B: l'handler è collegato **prima** della prima request wire (no race).
- [ ] `modelDefaults.oneShot` è disponibile su ogni account in cui il provider funziona.
- [ ] Build dual ESM+CJS produce `dist/` e `dist/cjs/` con `.d.ts`.
- [ ] (Esterno) `peerDependencies` pinnati su range compatibili.

---

## 8. Cosa NON fare

- **Non importare moduli host-internal** (`electron`, `better-sqlite3`, IPC del host). Tutto ciò che ti serve dal host arriva via `activate(host: HostServices)`.
- **Non leakare tipi nativi del SDK del provider** oltre il backend. Il host deve vedere solo `NormalizedMessage` & co.
- **Non dichiarare capability che non funzionano**. Il renderer mostrerà UI morta.
- **Non hardcodare `child_process.spawn`** — passa per `options.spawner`.
- **Non mutare `NormalizedMessage.raw`**. Serve per debug e per re-render lossless.
- **Non blockare in `activate`** su rete o disco. È fire-and-forget — fai il lavoro lazy nei metodi.
