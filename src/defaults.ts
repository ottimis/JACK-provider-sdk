/**
 * Provider-declared user defaults — per-provider "what you want this provider
 * to pick when a new session is created".
 *
 * Three field kinds are supported today: `model`, `effort`, and
 * `permission_mode`. Each provider declares which of those are meaningful
 * for its runtime and the catalog of legal values for each. The host owns
 * storage (via `HostServices.kv`) and resolution (`resolveProviderDefaults`
 * merges global → workspace → agent layers in the future; v1 is global
 * only). The provider only declares the **catalog**; it never persists or
 * resolves values itself.
 *
 * Design notes
 * ------------
 * - Catalog-only contract. The provider is authoritative on "what's
 *   settable" and "with which values". The host validates writes against
 *   this catalog and silently ignores stored values that fall outside it
 *   (e.g. after a provider bump removed a model).
 * - Presence-based gating. A provider that doesn't declare `defaults`
 *   simply doesn't appear in `Settings → Provider defaults` and no
 *   pre-fill happens. No `CapabilityMatrix` flag needed.
 * - Open for layering. The resolver signature (`workspaceId?`,
 *   `agentSlotId?`) is in v1 even though only the global layer is
 *   implemented, so adding workspace/agent overrides later is a host-only
 *   change without touching the SDK.
 *
 * Cross-references in the existing SDK surface
 * --------------------------------------------
 * - `model` overlaps with `JackProvider.modelOptions` (live dropdown) and
 *   `ProviderModelDefaults.oneShot` (host suggester tasks). The
 *   `ProviderDefaultsApi` is distinct: it answers "what model do new
 *   sessions get". A provider typically reuses `modelOptions` as the
 *   defaults catalog but it's not required (e.g. a provider could hide
 *   experimental models from the default-picker while keeping them in
 *   the live switcher).
 * - `effort` mirrors `JackProvider.effortLevels` semantics. Codex applies
 *   effort at spawn time; declaring it as a default is how the host
 *   honours that without an extra dropdown in `NewSessionDialog`.
 * - `permission_mode` mirrors `CapabilityMatrix.permissionModes`. The
 *   default is the mode every freshly-created session starts in
 *   (the user can still cycle it live via Shift-Tab if
 *   `livePermissionModeSwitch` is true).
 */

import type { AgentEffortLevel, AgentPermissionMode } from './backend'

/**
 * One field a provider exposes in the defaults form. Discriminated union
 * keyed on `kind` so the host renders the right widget (string-id select
 * for model, enum select for effort, etc.) without provider-specific code.
 *
 * `options` is the catalog of legal values. Empty → host hides the field
 * (parity with `JackProvider.modelOptions` / `effortLevels` semantics).
 */
export type ProviderDefaultsField =
  | {
      kind: 'model'
      /**
       * Catalog of model identifiers. `value` is what the host writes into
       * `sessions.model` at create time; `label` is the human display.
       * Typically reuses `JackProvider.modelOptions` 1:1 but providers MAY
       * filter (e.g. hide experimental models from new-session pre-fill).
       *
       * `aliases` + `supportsFastMode` mirror
       * {@link ProviderModelOption} (defined in `./provider`) for the same
       * model id — the host reads metadata from whichever catalog is
       * closest to the call site (live dropdown reads `modelOptions`,
       * new-session pre-fill reads this). Provider authors typically
       * duplicate fields across both catalogs by reference / spread; the
       * SDK doesn't enforce coherence.
       */
      options: ReadonlyArray<{
        value: string
        label: string
        aliases?: readonly string[]
        supportsFastMode?: boolean
      }>
    }
  | {
      kind: 'effort'
      /**
       * Catalog of effort tiers. `value` MUST be a member of
       * {@link AgentEffortLevel}. Renderer falls back to the raw string as
       * the label.
       */
      options: ReadonlyArray<AgentEffortLevel>
    }
  | {
      kind: 'permission_mode'
      /**
       * Catalog of permission modes available as session-start defaults.
       * Typically equals `CapabilityMatrix.permissionModes` but providers
       * MAY narrow (e.g. exclude `'bypassPermissions'` from the default
       * picker even when the cycle supports it — the user has to opt in
       * deliberately).
       */
      options: ReadonlyArray<AgentPermissionMode>
    }

/**
 * Provider-declared catalog of configurable defaults. Static — the host
 * reads `fields` once per provider listing and validates user writes
 * against it. Empty array would technically be valid but pointless; the
 * convention is "omit `JackProvider.defaults` entirely" for providers
 * with no defaults to expose.
 */
export type ProviderDefaultsApi = {
  readonly fields: ReadonlyArray<ProviderDefaultsField>
}

/**
 * Resolved defaults as the host serialises them per-provider in kv. Every
 * field is optional — "not set" means "use the provider's runtime default"
 * (model NULL, effort NULL, permission_mode 'default').
 *
 * Stored as a single JSON blob at `provider.<id>.defaults` so partial
 * writes are atomic and the host can wipe the whole bag in one call.
 */
export type ProviderDefaultsValues = {
  model?: string
  effort?: AgentEffortLevel
  permissionMode?: AgentPermissionMode
}

/**
 * Context the host resolver consumes. v1 only honours `providerId` (global
 * defaults). `workspaceId` and `agentSlotId` are reserved placeholders for
 * future per-workspace and per-agent overrides — the resolver signature
 * accepts them today so the call sites can be written once and the host
 * gains layering later without a callsite change.
 *
 * Resolution order (when layering lands): agent slot > workspace > global.
 * Per-field merge: each field is resolved independently, so an agent slot
 * can override `model` while letting `permissionMode` fall through to the
 * global value.
 */
export type ProviderDefaultsResolveContext = {
  providerId: string
  /** Reserved for future per-workspace defaults; ignored in v1. */
  workspaceId?: string
  /** Reserved for future per-agent-slot defaults; ignored in v1. */
  agentSlotId?: string
}
