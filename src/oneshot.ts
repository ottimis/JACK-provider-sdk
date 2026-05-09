/**
 * One-shot completion capability — fire-and-forget AI calls outside the
 * lifetime of a session.
 *
 * Use cases the host wires this for:
 *   - Auto-generate a commit message from a staged diff (CommitComposer).
 *   - Future: summarize a tool result, propose a search query, name a
 *     workspace from its first prompt, etc.
 *
 * Distinct from {@link AgentBackend.query} on purpose:
 *   - No tools, no MCP, no permission flow, no resume.
 *   - No persisted session — the provider MUST NOT leave artifacts on disk.
 *   - Returns plain text, synchronously to the caller (no streaming UI).
 *   - Reuses whatever auth/credentials the user already has (CLI cookie,
 *     API key, OAuth token) — same source as session calls.
 *
 * Provider implementations are expected to be **cheap and fast**: pick the
 * smallest reasonable model the user is authenticated for, no agentic
 * loops, no tool definitions, no caching beyond what the platform does on
 * its own. A typical call should complete in well under a second.
 */
export type OneshotCompleteOptions = {
  /**
   * The user prompt — what the model should respond to. The host builds
   * this string by interpolating the relevant context (diff, branch,
   * recent commit subjects, …) into a stable template; providers MUST
   * NOT re-prompt or transform it beyond what's needed for their wire
   * format.
   */
  prompt: string
  /**
   * Optional system prompt. Use sparingly — keeping the host-side prompt
   * provider-neutral means we can fan out the same call across providers
   * without re-tuning. Implementations that don't have a system slot
   * (rare) MAY prepend this to `prompt` and document the choice.
   */
  system?: string
  /**
   * Cap on output tokens. Providers MUST honor it as best they can; the
   * host treats overruns as warnings, not errors. Defaults are
   * provider-specific.
   */
  maxOutputTokens?: number
  /**
   * Cap on wall-clock time. Providers SHOULD abort the underlying request
   * when the deadline is exceeded and reject the returned promise rather
   * than block the caller forever. Default is provider-specific.
   */
  timeoutMs?: number
  /**
   * AbortSignal — host-controlled cancellation. Providers MUST wire this
   * into their underlying HTTP / process call so the renderer can drop a
   * pending generation when the user closes the dialog or navigates away.
   */
  signal?: AbortSignal
}

/**
 * One-shot completion API — optional capability on {@link JackProvider}.
 *
 * Providers that expose this MUST also declare `capabilities.oneshot =
 * true`. The host uses the capability flag to gate UI affordances (button
 * disabled, tooltip explaining "active provider doesn't support this")
 * before ever calling into the provider, so the API surface stays simple:
 * providers don't need to throw a "not implemented" error — they just
 * leave the field undefined.
 */
export type OneshotApi = {
  /**
   * Run a single non-agentic completion and return the assistant's text
   * verbatim — no streaming, no tool calls, no follow-up turns.
   *
   * Errors:
   *   - Network / auth: reject with the underlying error. Host catches and
   *     surfaces a toast.
   *   - AbortSignal aborted: reject with `DOMException('AbortError')`.
   *   - Empty / malformed model output: return an empty string. Host
   *     treats empty as "no suggestion" and keeps the textarea unchanged.
   */
  complete(opts: OneshotCompleteOptions): Promise<string>
}
