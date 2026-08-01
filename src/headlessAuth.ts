/**
 * Headless authentication affordance — how a human authenticates a provider
 * on a machine with no browser, no keychain and no display.
 *
 * Motivating case
 * ---------------
 * A Jack node (`jackd`, ADR 0023) runs headless. It has no login UI, no
 * window to open, and its `cookieLogin` seam correctly reports an error —
 * {@link HostServices.auth.openCookieLoginWindow} is irreducibly a window and
 * cannot be the answer here. All a node can usefully do is tell its operator
 * *"run this to authenticate this provider"*.
 *
 * Producing that sentence without this capability means the host hardcoding
 * `claude auth login`, which is exactly the provider-specific host code the
 * provider-compliance rule forbids. `SlashCommandSupport.terminalRun` is not
 * the answer either: it is a *slash command* surface, keyed by a command name
 * the host must know, and it presumes a terminal the node's clients don't
 * have.
 *
 * The out-of-band flow itself already works — for Claude,
 * `claude auth login --claudeai` prints a PKCE authorize URL and reads a
 * pasted code from stdin. What was missing is a way for the provider to
 * *declare* it.
 *
 * Design notes
 * ------------
 * - **The host prints, never parses.** {@link HeadlessAuthCommand.commandLine}
 *   is opaque provider CLI syntax. The host renders it (boot log, future
 *   client surface) and nothing else — no tokenizing, no rewriting, no
 *   inferring flags from it.
 * - **Profile-aware.** {@link HeadlessAuthApi.command} takes the profile the
 *   operator wants to authenticate and returns whatever env pins it, so a node
 *   with more than one profile can authenticate each. The provider resolves
 *   that env itself (Claude via `profiles.applyProfile`); the host never names
 *   the variable.
 * - **Presence-based gating**, like {@link DiagnosticsApi} /
 *   {@link ProviderDefaultsApi}: a provider that omits
 *   `JackProvider.headlessAuth` simply has no headless affordance to offer and
 *   the host says nothing. No `CapabilityMatrix` flag — there is no persistent
 *   UI affordance to gate.
 * - **The human stays in the loop.** Nothing here automates the login: the
 *   operator runs the command and pastes the code by hand. That is the
 *   security property, not a limitation to engineer around.
 * - **Credentials are the runtime's business.** Where the credential lands is
 *   decided entirely by the provider CLI; Jack never reads or moves it.
 */

/**
 * A resolved command line the operator runs on the node to authenticate.
 * Fully composed by the provider — the host treats every field as opaque.
 */
export type HeadlessAuthCommand = {
  /**
   * The full command line, in the provider's own CLI syntax, **including the
   * binary** — e.g. `claude auth login --claudeai`.
   *
   * Following the {@link TerminalRunSpec.commandLine} precedent (SDK 0.27) and
   * for the same reason: the host never composes provider CLI syntax, so the
   * binary belongs to the provider's string rather than to some host-side
   * convention about who prepends what.
   *
   * The host PRINTS this verbatim. It MUST NOT parse, split, rewrite, or
   * infer anything from it.
   */
  commandLine: string
  /**
   * Working directory the command should be run from, when the provider
   * requires one. Omitted means "anywhere" — the host prints nothing extra.
   */
  cwd?: string
  /**
   * Environment variables that must be set for this invocation, notably
   * whatever pins the requested profile (Claude: `CLAUDE_CONFIG_DIR`,
   * resolved by the provider through `profiles.applyProfile` — the host does
   * not know or name it).
   *
   * The host renders these alongside the command line so the operator can
   * export them. Verbatim, like {@link commandLine}: values are the
   * provider's, never interpreted.
   */
  env?: Record<string, string>
}

/**
 * Input for {@link HeadlessAuthApi.command}. Intentionally small; new fields
 * are additive (optional) so this can grow without a major bump.
 */
export type HeadlessAuthCommandInput = {
  /**
   * Profile the operator wants to authenticate. Omitted = the runtime's
   * implicit default profile.
   *
   * Providers with a profiles capability MUST honor it — a node with more
   * than one profile can only authenticate each account if the returned
   * command carries that profile's pinning env.
   * Providers without a profile concept ignore the field.
   */
  profileId?: string
}

/**
 * Optional capability on {@link JackProvider}. A provider that exposes it can
 * tell a headless host what a human should run, on that box, to authenticate
 * — without the host ever knowing the provider's CLI syntax.
 *
 * Presence-based: when the field is undefined the host has no headless auth
 * affordance for that provider and never calls in.
 */
export type HeadlessAuthApi = {
  /**
   * Resolve the command line the operator runs on the node.
   *
   * Contract:
   *   - MUST return a self-contained {@link HeadlessAuthCommand.commandLine}
   *     (binary included) in the provider's own CLI syntax.
   *   - MUST carry, in `env`, whatever pins `input.profileId` when the
   *     provider has profiles.
   *   - MUST NOT perform the login, mutate credentials, or touch the
   *     network — this only *describes* what the human will run.
   *   - Cheap: the host may call it on a boot path.
   */
  command(input: HeadlessAuthCommandInput): Promise<HeadlessAuthCommand>
  /**
   * One line a client renders above the command, e.g. explaining that the
   * flow prints a URL and waits for a pasted code. Rendered verbatim; omit
   * for no hint.
   */
  hint?: string
  /**
   * Name of the environment variable carrying a non-interactive credential
   * (API key / long-lived token), when the provider has such an alternative.
   * The host renders the *name* as a second option for unattended setups; it
   * never reads, stores, or forwards a value.
   *
   * Omitted when the provider's only path is the interactive out-of-band
   * flow.
   */
  tokenEnvVar?: string
}
