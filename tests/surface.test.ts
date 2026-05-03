import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  localSpawner,
  type AgentBackend,
  type AgentQueryOptions,
  type AgentSession,
  type BackendName,
  type CapabilityMatrix,
  type JackProvider,
  type ProcessSpawner,
  type ProviderBranding,
  type ProviderModelOption,
  type PersistedPermissionsApi,
  type SlashCommandDef,
  type ToolDescriptor
} from '../src/index'

// Surface-level smoke: the package's public API must remain importable
// and the few runtime values it exposes must keep their shape. These
// tests don't exercise behaviour — they catch accidental removals from
// the barrel and silent type drift before downstream consumers do.

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

test('optional fields on JackProvider type-check cleanly', () => {
  const branding: ProviderBranding = { accentColor: '#abc', iconKey: 'sparkles' }
  const model: ProviderModelOption = { value: 'opus', label: 'Opus' }
  const cmd: SlashCommandDef = {
    name: 'help', scope: 'builtin', body: '', filePath: ''
  }
  const tool: ToolDescriptor = {
    providerToolName: 'Read', shape: 'fs.read', cardStyle: 'bespoke'
  }
  const perms: PersistedPermissionsApi = {
    list: () => ({
      user: { source: 'user', path: null, exists: false, allow: [], deny: [], ask: [] },
      userLocal: { source: 'userLocal', path: null, exists: false, allow: [], deny: [], ask: [] },
      project: { source: 'project', path: null, exists: false, allow: [], deny: [], ask: [] },
      projectLocal: { source: 'projectLocal', path: null, exists: false, allow: [], deny: [], ask: [] }
    }),
    add: () => false,
    remove: () => false
  }
  // Touch each binding so the test fails if a type narrows to never.
  assert.ok(branding.accentColor && model.value && cmd.name && tool.shape && perms.list)
})

test('BackendName is an open string union', () => {
  const claudeSdk: BackendName = 'sdk'
  const claudeCli: BackendName = 'cli'
  const geminiAcp: BackendName = 'acp'
  const future: BackendName = 'whatever-comes-next'
  assert.deepEqual(
    [claudeSdk, claudeCli, geminiAcp, future].length,
    4
  )
})

test('ProcessSpawner shape is callable with abort + env', () => {
  const fake: ProcessSpawner = () => {
    throw new Error('not invoked')
  }
  assert.equal(typeof fake, 'function')
})

test('AgentBackend / AgentSession interfaces remain referenceable', () => {
  // Compile-time check only — assigning `null as unknown as T` ensures the
  // type is exported without forcing a real runtime instance.
  const backend = null as unknown as AgentBackend
  const session = null as unknown as AgentSession
  const options = null as unknown as AgentQueryOptions
  assert.equal(backend, null)
  assert.equal(session, null)
  assert.equal(options, null)
})
