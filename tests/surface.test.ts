import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { z } from 'zod'
import * as sdk from '../src/index'
import {
  localSpawner,
  type AgentBackend,
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
  type InProcessMcpServerSpec,
  type InProcessMcpToolSpec,
  type JackProvider,
  type KnowledgeContext,
  type McpServerSpec,
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
  type ProviderPolicies,
  type SlashCommandDef,
  type SlashCommandScope,
  type SlashCommandSupport,
  type SpawnArgs,
  type ToolDescriptor
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
    permissionGranularity: 'callback'
  }
  assert.equal(caps.liveEffortSwitch, false)
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
