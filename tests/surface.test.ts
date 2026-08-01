import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { z } from 'zod'
import * as sdk from '../src/index'
import {
  localSpawner,
  type AgentBackend,
  type AgentContextUsage,
  type AgentEffortLevel,
  type AgentForkSessionOptions,
  type AgentListSessionsOptions,
  type AgentPermissionMode,
  type AgentQueryOptions,
  type AgentSession,
  type AgentSettingsResponse,
  type AgentSystemPrompt,
  type BackendDescriptor,
  type BackendName,
  type CapabilityMatrix,
  type ClientToolHandlerAttachContext,
  type DiagnosticsApi,
  type DiagnosticsInspectContext,
  type HeadlessAuthApi,
  type HeadlessAuthCommand,
  type HeadlessAuthCommandInput,
  type InProcessMcpServerSpec,
  type InProcessMcpToolSpec,
  type JackProvider,
  type KnowledgeContext,
  type McpServerSpec,
  type MonthlySpendMetric,
  type ParsedSlashEnvelope,
  type PermissionBehavior,
  type PermissionRule,
  type PermissionSource,
  type PermissionsSnapshot,
  type PermissionsSourceBlock,
  type PersistedPermissionsApi,
  type ProcessHandle,
  type ProcessSpawner,
  type ProviderBranding,
  type ProviderDetectResult,
  type ProviderIconKey,
  type ProviderModelDefaults,
  type ProviderModelOption,
  type ProviderDiagnostic,
  type ProviderDiagnosticSeverity,
  type ProviderPolicies,
  type SessionTranscriptState,
  type SessionTranscriptStateOptions,
  type SlashCommandDef,
  type SlashCommandScope,
  type SlashCommandSupport,
  type SpawnArgs,
  type TerminalRunSpec,
  type TimeWindowMetric,
  type TokenUtilizationMetric,
  type ToolDescriptor,
  type UsageApi,
  type UsageConnectContext,
  type UsageConnectOption,
  type UsageConnectResult,
  type UsageMetric,
  type UsageSnapshot,
  type UsageStatus
} from '../src/index'

// Surface-level smoke: every named export the README/spec promises must
// remain importable AND keep its shape. These tests catch silent removals
// from the barrel and silent type drift before downstream consumers do.

test('barrel re-exports the runtime spawner', () => {
  assert.equal(typeof localSpawner, 'function')
})

test('JackProvider interface accepts a minimal valid implementation', () => {
  const minimal: JackProvider = {
    id: 'fixture',
    label: 'Fixture',
    detect: async () => ({ installed: true }),
    backends: [],
    defaultBackendId: 'sdk',
    capabilities: {} as CapabilityMatrix,
    modelDefaults: { oneShot: 'cheap-model' },
    toolCatalog: [],
    parseToolName: (rawName) => ({ kind: 'native', toolName: rawName }),
    applyKnowledgeContext: () => {},
    readSessionTranscript: async () => []
  }
  assert.equal(minimal.id, 'fixture')
})

test('SlashCommandDef discriminates by scope', () => {
  const builtin: SlashCommandDef = { name: 'help', scope: 'builtin' }
  const wireSourced: SlashCommandDef = { name: 'memory show', scope: 'wire' }
  const userFile: SlashCommandDef = {
    name: 'review', scope: 'user', body: '...', filePath: '/abs/.../review.md'
  }
  // The narrowing contract: scope tells you which fields exist.
  assert.equal(builtin.scope, 'builtin')
  assert.equal(wireSourced.scope, 'wire')
  if (userFile.scope === 'user' || userFile.scope === 'project') {
    assert.equal(userFile.body, '...')
  }
})

test('SlashCommandSupport.terminalRun is optional and returns TerminalRunSpec | null', () => {
  // Omitting terminalRun is valid — providers without a terminal bridge
  // (Codex, Gemini) leave it undefined and get the legacy refusal.
  const noBridge: SlashCommandSupport = { builtins: [] }
  assert.equal(noBridge.terminalRun, undefined)

  const autoRun: TerminalRunSpec = { commandLine: 'claude auth login', autoRun: true }
  const needsInput: TerminalRunSpec = {
    commandLine: 'claude plugin install ',
    autoRun: false
  }
  const tuiOnly: TerminalRunSpec = {
    commandLine: 'claude',
    autoRun: false,
    hint: 'then type /config in the session'
  }

  // When present, the mapping keys off the canonical name (no leading
  // slash) + rawArgs and returns the union TerminalRunSpec | null.
  const withBridge: SlashCommandSupport = {
    builtins: [],
    terminalRun(name: string, rawArgs: string): TerminalRunSpec | null {
      if (name === 'login') return autoRun
      if (name === 'plugin') {
        return { commandLine: `claude plugin ${rawArgs}`.trimEnd(), autoRun: rawArgs.length > 0 }
      }
      if (name === 'config') return tuiOnly
      return null // not terminal-runnable → host shows "not available"
    }
  }

  assert.deepEqual(withBridge.terminalRun?.('login', ''), autoRun)
  assert.equal(withBridge.terminalRun?.('plugin', '')?.autoRun, false)
  assert.equal(withBridge.terminalRun?.('plugin', 'install foo')?.autoRun, true)
  assert.equal(withBridge.terminalRun?.('config', '')?.hint, 'then type /config in the session')
  assert.equal(withBridge.terminalRun?.('resume', ''), null)
  assert.equal(needsInput.autoRun, false)
})

test('SlashCommandScope is open-ended for forward compat', () => {
  const known: SlashCommandScope = 'builtin'
  const future: SlashCommandScope = 'whatever-future-scope'
  assert.equal([known, future].length, 2)
})

test('PermissionRule uses raw + optional humanReadable', () => {
  const minimal: PermissionRule = { raw: 'Bash(npm install)' }
  const claudeStyle: PermissionRule = {
    raw: 'Bash(npm install)',
    humanReadable: { tool: 'Bash', pattern: 'npm install' }
  }
  assert.equal(minimal.raw, 'Bash(npm install)')
  assert.equal(claudeStyle.humanReadable?.tool, 'Bash')
})

test('PermissionsSnapshot covers four cascade sources', () => {
  const empty = (source: PermissionSource): PermissionsSourceBlock => ({
    source, path: null, exists: false, allow: [], deny: [], ask: []
  })
  const snap: PermissionsSnapshot = {
    user: empty('user'),
    userLocal: empty('userLocal'),
    project: empty('project'),
    projectLocal: empty('projectLocal')
  }
  assert.equal(Object.keys(snap).length, 4)
})

test('PersistedPermissionsApi shape', () => {
  const api: PersistedPermissionsApi = {
    list: () => ({
      user: { source: 'user', path: null, exists: false, allow: [], deny: [], ask: [] },
      userLocal: { source: 'userLocal', path: null, exists: false, allow: [], deny: [], ask: [] },
      project: { source: 'project', path: null, exists: false, allow: [], deny: [], ask: [] },
      projectLocal: { source: 'projectLocal', path: null, exists: false, allow: [], deny: [], ask: [] }
    }),
    add: () => false,
    remove: () => false
  }
  const behavior: PermissionBehavior = 'allow'
  assert.equal(typeof api.list, 'function')
  assert.equal(behavior, 'allow')
})

test('McpServerSpec discriminated union covers stdio / http / sse', () => {
  const stdio: McpServerSpec = { type: 'stdio', command: 'mcp-bin' }
  const http: McpServerSpec = { type: 'http', url: 'https://example.com' }
  const sse: McpServerSpec = { type: 'sse', url: 'https://example.com/sse' }
  assert.deepEqual([stdio.type, http.type, sse.type], ['stdio', 'http', 'sse'])
})

test('AgentQueryOptions.mcpServers is keyed McpServerSpec', () => {
  const opts: AgentQueryOptions = {
    cwd: '/tmp',
    mcpServers: {
      filesystem: { type: 'stdio', command: 'mcp-fs' }
    }
  }
  assert.equal(opts.mcpServers?.filesystem.type, 'stdio')
})

test('CapabilityMatrix exposes liveEffortSwitch (decoupled from liveModelSwitch)', () => {
  const caps: CapabilityMatrix = {
    partialMessages: false,
    hooks: { PreToolUse: false, PostToolUse: false },
    planMode: false,
    askUserQuestion: false,
    subagents: 'none',
    mcp: false,
    structuredPatch: false,
    resumeSession: false,
    liveModelSwitch: true,
    liveEffortSwitch: false,
    livePermissionModeSwitch: false,
    permissionGranularity: 'callback',
    usage: false,
    permissionModes: ['default']
  }
  assert.equal(caps.liveEffortSwitch, false)
  assert.deepEqual(caps.permissionModes, ['default'])
})

test('CapabilityMatrix.permissionModes is provider-declared catalog', () => {
  const claudeShape: CapabilityMatrix['permissionModes'] = [
    'default',
    'acceptEdits',
    'plan',
    'auto'
  ]
  const codexShape: CapabilityMatrix['permissionModes'] = [
    'default',
    'acceptEdits',
    'bypassPermissions'
  ]
  // AgentPermissionMode is now open — providers can invent new strings
  // without breaking the type.
  const futureShape: CapabilityMatrix['permissionModes'] = [
    'default',
    'whatever-future-mode'
  ]
  assert.equal(claudeShape.length, 4)
  assert.equal(codexShape.length, 3)
  assert.equal(futureShape[1], 'whatever-future-mode')
})

test('permissionGranularity hybrid open union', () => {
  const knownCallback: CapabilityMatrix['permissionGranularity'] = 'callback'
  const knownSandbox: CapabilityMatrix['permissionGranularity'] = 'sandbox-only'
  const knownHybrid: CapabilityMatrix['permissionGranularity'] = 'hybrid'
  const future: CapabilityMatrix['permissionGranularity'] = 'tty-interactive'
  assert.deepEqual([knownCallback, knownSandbox, knownHybrid, future].length, 4)
})

test('AgentSession.setEffortLevel takes typed effort level', () => {
  type Method = AgentSession['setEffortLevel']
  // Compile-time only — invoking the method on a null cast would crash.
  const ok: Method = (effort: AgentEffortLevel | undefined) => {
    return Promise.resolve(effort)
  }
  assert.equal(typeof ok, 'function')
})

test('ClientToolHandlerAttachContext has required sessionId + optional actorId', () => {
  const ctx: ClientToolHandlerAttachContext = {
    sessionId: 'host-session-123',
    actorId: 'self'
  }
  assert.equal(ctx.sessionId, 'host-session-123')
})

test('ProviderBranding accepts curated iconKey + accent color', () => {
  const branding: ProviderBranding = {
    accentColor: '#D97757',
    iconKey: 'sparkles'
  }
  const future: ProviderIconKey = 'future-icon'
  assert.equal(branding.iconKey, 'sparkles')
  assert.equal(future, 'future-icon')
})

test('ProviderModelOption / ModelDefaults', () => {
  const opt: ProviderModelOption = { value: 'opus', label: 'Opus' }
  const defaults: ProviderModelDefaults = { oneShot: 'haiku' }
  assert.equal(opt.value, 'opus')
  assert.equal(defaults.oneShot, 'haiku')
})

test('DiagnosticsApi — spawn diagnostics capability surface', () => {
  const severity: ProviderDiagnosticSeverity = 'warning'
  const diag: ProviderDiagnostic = {
    id: 'claude.memory.oversize',
    severity,
    title: 'Large CLAUDE.md file detected',
    detail: '/repo/CLAUDE.md — 52,000 chars (> 40,000)',
    paths: ['/repo/CLAUDE.md']
  }
  const api: DiagnosticsApi = {
    inspectSpawn: async (ctx: DiagnosticsInspectContext) => {
      assert.equal(typeof ctx.cwd, 'string')
      return [diag]
    }
  }
  // Presence-based capability: a provider MAY attach it to JackProvider.
  const provider: Partial<JackProvider> = { diagnostics: api }
  assert.equal(provider.diagnostics, api)
  assert.equal(diag.severity, 'warning')
  assert.deepEqual(diag.paths, ['/repo/CLAUDE.md'])
})

test('HeadlessAuthApi — headless login affordance, profile-aware', async () => {
  // The provider owns the whole string, binary included (TerminalRunSpec
  // precedent): the host prints it and never composes provider CLI syntax.
  const api: HeadlessAuthApi = {
    async command(input: HeadlessAuthCommandInput): Promise<HeadlessAuthCommand> {
      // Profile-aware: whatever pins the requested profile rides in `env`,
      // resolved by the provider (Claude: via profiles.applyProfile). The
      // host never names the variable.
      return {
        commandLine: 'claude auth login --claudeai',
        ...(input.profileId
          ? { env: { CLAUDE_CONFIG_DIR: `/home/op/.claude-${input.profileId}` } }
          : {})
      }
    },
    hint: 'prints a URL — open it elsewhere and paste the code back',
    tokenEnvVar: 'ANTHROPIC_API_KEY'
  }

  const implicitDefault = await api.command({})
  assert.equal(implicitDefault.commandLine, 'claude auth login --claudeai')
  assert.equal(implicitDefault.env, undefined)
  assert.equal(implicitDefault.cwd, undefined)

  // A node with more than one profile can authenticate each: same command
  // line, different pinning env.
  const work = await api.command({ profileId: 'work' })
  const personal = await api.command({ profileId: 'personal' })
  assert.equal(work.commandLine, personal.commandLine)
  assert.notDeepEqual(work.env, personal.env)

  assert.equal(api.tokenEnvVar, 'ANTHROPIC_API_KEY')

  // Presence-based capability: a provider MAY attach it to JackProvider…
  const provider: Partial<JackProvider> = { headlessAuth: api }
  assert.equal(provider.headlessAuth, api)

  // …and one that omits it keeps working unchanged — the host simply has no
  // headless affordance to offer for it.
  const minimal: JackProvider = {
    id: 'no-headless-auth',
    label: 'NoHeadlessAuth',
    detect: async () => ({ installed: true }),
    backends: [],
    defaultBackendId: 'sdk',
    capabilities: {} as CapabilityMatrix,
    modelDefaults: { oneShot: 'cheap-model' },
    toolCatalog: [],
    parseToolName: (rawName) => ({ kind: 'native', toolName: rawName }),
    applyKnowledgeContext: () => {},
    readSessionTranscript: async () => []
  }
  assert.equal(minimal.headlessAuth, undefined)

  // `hint` and `tokenEnvVar` are optional too — the interactive out-of-band
  // flow alone is a complete implementation.
  const bare: HeadlessAuthApi = {
    command: async () => ({ commandLine: 'someagent login', cwd: '/srv/app' })
  }
  assert.equal(bare.hint, undefined)
  assert.equal(bare.tokenEnvVar, undefined)
  assert.equal((await bare.command({ profileId: 'ignored' })).cwd, '/srv/app')
})

test('InProcessMcpToolSpec.schema is a zod-shape', () => {
  const tool: InProcessMcpToolSpec = {
    name: 'echo',
    description: 'echoes input',
    schema: { input: z.string() },
    handler: async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(args) }]
    })
  }
  const server: InProcessMcpServerSpec = {
    name: 'jack', version: '1.0.0', tools: [tool]
  }
  assert.equal(server.tools[0]?.name, 'echo')
})

test('BackendName is an open string union', () => {
  const claudeSdk: BackendName = 'sdk'
  const claudeCli: BackendName = 'cli'
  const geminiAcp: BackendName = 'acp'
  const future: BackendName = 'whatever-comes-next'
  assert.equal([claudeSdk, claudeCli, geminiAcp, future].length, 4)
})

test('ProcessSpawner / ProcessHandle / SpawnArgs typecheck', () => {
  const fake: ProcessSpawner = (_args: SpawnArgs): ProcessHandle => {
    throw new Error('not invoked')
  }
  assert.equal(typeof fake, 'function')
})

test('AgentBackend / Session / forkSession / listSessions interfaces present', () => {
  const backend = null as unknown as AgentBackend
  const session = null as unknown as AgentSession
  const fork = null as unknown as AgentForkSessionOptions
  const list = null as unknown as AgentListSessionsOptions
  const settings = null as unknown as AgentSettingsResponse
  const systemPrompt = null as unknown as AgentSystemPrompt
  const mode = null as unknown as AgentPermissionMode
  const desc = null as unknown as BackendDescriptor
  const knowledge = null as unknown as KnowledgeContext
  const policies = null as unknown as ProviderPolicies
  const tool = null as unknown as ToolDescriptor
  const detect = null as unknown as ProviderDetectResult
  const support = null as unknown as SlashCommandSupport
  const env = null as unknown as ParsedSlashEnvelope
  assert.equal(backend, null)
  assert.equal(session, null)
  assert.equal(fork, null)
  assert.equal(list, null)
  assert.equal(settings, null)
  assert.equal(systemPrompt, null)
  assert.equal(mode, null)
  assert.equal(desc, null)
  assert.equal(knowledge, null)
  assert.equal(policies, null)
  assert.equal(tool, null)
  assert.equal(detect, null)
  assert.equal(support, null)
  assert.equal(env, null)
})

test('barrel exports a stable, documented set of names', () => {
  // Smoke: the barrel's enumerable runtime exports include every value
  // mentioned in the README. Removing one would break consumers.
  const exportedRuntime = Object.keys(sdk).sort()
  assert.ok(exportedRuntime.includes('localSpawner'), 'localSpawner missing')
})

test('UsageMetric discriminates by kind', () => {
  const tw: TimeWindowMetric = {
    kind: 'time_window',
    id: 'five_hour',
    label: '5-hour usage',
    utilization: 0.42,
    resetsAt: '2026-05-03T18:00:00Z',
    windowSeconds: 18000
  }
  const twWithCount: TimeWindowMetric = {
    kind: 'time_window',
    id: 'daily',
    label: 'Daily quota',
    utilization: 0.24,
    used: 12,
    limit: 50,
    unit: 'requests',
    resetsAt: '2026-05-04T00:00:00Z',
    windowSeconds: 86400
  }
  const tu: TokenUtilizationMetric = {
    kind: 'token_utilization',
    id: 'context',
    label: 'Context',
    used: 23456,
    max: 200000
  }
  const ms: MonthlySpendMetric = {
    kind: 'monthly_spend',
    id: 'may-2026',
    label: 'May 2026',
    spentUsd: 12.34,
    cycleStart: '2026-05-01T00:00:00Z',
    cycleEnd: '2026-05-31T23:59:59Z'
  }
  const all: UsageMetric[] = [tw, twWithCount, tu, ms]
  // Narrow on `kind` to verify the union shape.
  for (const m of all) {
    if (m.kind === 'time_window') assert.equal(typeof m.utilization, 'number')
    else if (m.kind === 'token_utilization') assert.equal(typeof m.used, 'number')
    else assert.equal(typeof m.spentUsd, 'number')
  }
})

test('UsageSnapshot allows empty metrics + verbatim raw passthrough', () => {
  const empty: UsageSnapshot = {
    metrics: [],
    observedAt: '2026-05-03T12:00:00Z'
  }
  const withRaw: UsageSnapshot = {
    metrics: [],
    observedAt: '2026-05-03T12:00:00Z',
    raw: { upstream: 'verbatim payload here' }
  }
  assert.equal(empty.metrics.length, 0)
  assert.deepEqual(withRaw.raw, { upstream: 'verbatim payload here' })
})

test('UsageConnectResult discriminates ready / choose / error / cancelled', () => {
  const ready: UsageConnectResult = { kind: 'ready', identity: 'mm@ottimis.com' }
  const choose: UsageConnectResult = {
    kind: 'choose',
    options: [{ id: 'org-a', label: 'Acme' }, { id: 'org-b', label: 'Beta' }]
  }
  const err: UsageConnectResult = { kind: 'error', error: 'cookie missing' }
  const cancel: UsageConnectResult = { kind: 'cancelled' }
  const opt: UsageConnectOption = { id: 'opt', label: 'Opt' }
  const ctx: UsageConnectContext = { parentWindow: undefined }
  assert.deepEqual([ready.kind, choose.kind, err.kind, cancel.kind], [
    'ready', 'choose', 'error', 'cancelled'
  ])
  assert.equal(opt.label, 'Opt')
  assert.equal(ctx.parentWindow, undefined)
})

test('UsageStatus carries identity + authMode hints', () => {
  const status: UsageStatus = {
    connected: true,
    identity: 'mm@ottimis.com',
    authMode: 'subscription'
  }
  const future: UsageStatus = {
    connected: true,
    authMode: 'whatever-future-mode'
  }
  assert.equal(status.authMode, 'subscription')
  assert.equal(future.authMode, 'whatever-future-mode')
})

test('UsageApi accepts a minimal pure-format-only implementation', () => {
  const api: UsageApi = {
    status: async () => ({ connected: false }),
    connect: async () => ({ kind: 'cancelled' as const }),
    disconnect: async () => {},
    fetch: async () => ({ metrics: [], observedAt: new Date().toISOString() }),
    formatSessionMetrics: (raw: AgentContextUsage): UsageMetric[] => {
      const total = typeof raw.totalTokens === 'number' ? raw.totalTokens : 0
      const max = typeof raw.maxTokens === 'number' ? raw.maxTokens : undefined
      return [{ kind: 'token_utilization', id: 'context', label: 'Context', used: total, max }]
    }
  }
  // Compile-time only — calling status() would just return the dummy.
  assert.equal(typeof api.status, 'function')
  assert.equal(typeof api.formatSessionMetrics, 'function')
})

test('CapabilityMatrix declares the new usage flag', () => {
  const off: CapabilityMatrix = {
    partialMessages: false,
    hooks: { PreToolUse: false, PostToolUse: false },
    planMode: false,
    askUserQuestion: false,
    subagents: 'none',
    mcp: false,
    structuredPatch: false,
    resumeSession: false,
    liveModelSwitch: false,
    liveEffortSwitch: false,
    livePermissionModeSwitch: false,
    permissionGranularity: 'callback',
    usage: false
  }
  assert.equal(off.usage, false)
})

test('JackProvider.usage is optional', () => {
  const noUsage: JackProvider = {
    id: 'no-usage',
    label: 'NoUsage',
    detect: async () => ({ installed: true }),
    backends: [],
    defaultBackendId: 'sdk',
    capabilities: {} as CapabilityMatrix,
    modelDefaults: { oneShot: 'cheap-model' },
    toolCatalog: [],
    parseToolName: (rawName) => ({ kind: 'native', toolName: rawName }),
    applyKnowledgeContext: () => {},
    readSessionTranscript: async () => []
    // no `usage` field — host hides chip Connect affordance
  }
  assert.equal(noUsage.usage, undefined)
})

test('JackProvider.canonicalModelId is optional and folds same-model ids', () => {
  const withCanon: JackProvider = {
    id: 'canon',
    label: 'Canon',
    detect: async () => ({ installed: true }),
    backends: [],
    defaultBackendId: 'sdk',
    capabilities: {} as CapabilityMatrix,
    modelDefaults: { oneShot: 'cheap-model' },
    toolCatalog: [],
    parseToolName: (rawName) => ({ kind: 'native', toolName: rawName }),
    applyKnowledgeContext: () => {},
    readSessionTranscript: async () => [],
    // Strips the context-window decoration so `foo[1m]` and `foo` compare
    // equal for switch detection, while preserving genuine family differences.
    canonicalModelId: (modelId) => modelId.replace(/\[1m\]$/i, '')
  }
  assert.equal(withCanon.canonicalModelId?.('claude-opus-4-8[1m]'), 'claude-opus-4-8')
  assert.equal(withCanon.canonicalModelId?.('claude-opus-4-8'), 'claude-opus-4-8')
  assert.notEqual(
    withCanon.canonicalModelId?.('claude-fable-5'),
    withCanon.canonicalModelId?.('claude-opus-4-8')
  )

  const noCanon: JackProvider = { ...withCanon, id: 'no-canon' }
  delete (noCanon as { canonicalModelId?: unknown }).canonicalModelId
  assert.equal(noCanon.canonicalModelId, undefined)
})

test('JackProvider.sessionTranscriptState is optional and tri-state', async () => {
  // The tri-state is a closed union — asserting the three legal members and
  // that the conservative `'unknown'` is representable is the whole contract.
  const states: SessionTranscriptState[] = ['present', 'missing', 'unknown']
  assert.deepEqual(states, ['present', 'missing', 'unknown'])

  const withState: JackProvider = {
    id: 'transcript-state',
    label: 'TranscriptState',
    detect: async () => ({ installed: true }),
    backends: [],
    defaultBackendId: 'sdk',
    capabilities: {} as CapabilityMatrix,
    modelDefaults: { oneShot: 'cheap-model' },
    toolCatalog: [],
    parseToolName: (rawName) => ({ kind: 'native', toolName: rawName }),
    applyKnowledgeContext: () => {},
    readSessionTranscript: async () => [],
    // A provider that cannot honor a supplied configDir MUST fall back to
    // 'unknown' rather than probe the wrong root and risk a false 'missing'.
    sessionTranscriptState: async (opts: SessionTranscriptStateOptions) =>
      opts.configDir ? 'unknown' : 'present'
  }
  assert.equal(
    await withState.sessionTranscriptState?.({ providerSessionId: 's1' }),
    'present'
  )
  assert.equal(
    await withState.sessionTranscriptState?.({
      providerSessionId: 's1',
      configDir: '/some/pinned/root'
    }),
    'unknown'
  )

  // Presence-based gating: omitting the method means the host treats the
  // provider as all-'unknown' and never sweeps its sessions.
  const noState: JackProvider = { ...withState, id: 'no-transcript-state' }
  delete (noState as { sessionTranscriptState?: unknown }).sessionTranscriptState
  assert.equal(noState.sessionTranscriptState, undefined)
})
