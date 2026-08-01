/**
 * Transcript portability — moving one conversation between machines.
 *
 * Motivating case
 * ---------------
 * A Jack node (`jackd`, ADR 0023) and a desktop are two hosts that never talk
 * to each other: a session moves between them as an **explicit handoff**,
 * carried by the client that is paired with both. Fidelity is the entire point
 * of that move — a lossy variant is the compact handoff Jack already has.
 *
 * {@link ProfilesApi.transferSession} cannot be generalised into it. It takes
 * `fromProfileId` / `toProfileId` and does the copy **inside one process, on
 * one filesystem**; a cross-machine move has two of each. So the single call
 * becomes two halves — one host reads, the other writes — and neither half
 * ever sees the other's disk.
 *
 * `readSessionTranscript` is not the answer either: it returns canonical
 * `NormalizedMessage[]`, which renders a conversation but cannot resume one.
 *
 * Design notes
 * ------------
 * - **The blob is opaque to the host.** {@link TranscriptExportResult.content}
 *   is base64 and {@link TranscriptExportResult.format} is a provider-owned
 *   tag; the host stores, carries and echoes both, and parses neither. This is
 *   what keeps the transcript layout — the provider shape par excellence —
 *   out of the host, consistent with `profiles.ts`: *"Jack never reads or
 *   writes inside `configDir`"*.
 * - **Top-level, not on {@link ProfilesApi}.** A provider without profiles
 *   still has transcripts; gating machine-portability behind a profiles
 *   capability would only record where the first implementation happened to
 *   live.
 * - **Presence-based gating**, like {@link DiagnosticsApi} /
 *   {@link ProviderDefaultsApi}: a provider that omits
 *   `JackProvider.transcripts` cannot relocate a conversation, and every
 *   handoff surface goes *absent* rather than disabled. No `CapabilityMatrix`
 *   flag.
 * - **{@link ProfilesApi.transferSession} stays as it is.** Same-machine
 *   cross-profile transfer is a copy the provider does better in one step;
 *   re-expressing it as export + import would be a refactor with real
 *   regression risk and no gain.
 * - **Credentials do not travel.** A transcript is context, not auth: each
 *   machine authenticates its own provider (ADR 0023).
 */

/**
 * Result of {@link TranscriptPortabilityApi.exportSession}.
 *
 * `content` is the whole transcript, base64-encoded, in a single value — see
 * {@link TranscriptPortabilityApi.exportSession} for why there is no
 * streaming form.
 */
export type TranscriptExportResult =
  | { ok: true; format: string; content: string }
  | { ok: false; error: string }

/** Result of {@link TranscriptPortabilityApi.importSession}. */
export type TranscriptImportResult = { ok: true } | { ok: false; error: string }

/**
 * Optional capability on {@link JackProvider}. A provider that exposes it can
 * hand a resumable conversation to another machine and take one back.
 *
 * Presence-based: when the field is undefined the host offers no cross-machine
 * move for that provider and never calls in.
 */
export type TranscriptPortabilityApi = {
  /**
   * Read a resumable transcript out of this machine's provider storage.
   *
   * Contract:
   *   - `content` MUST be base64, and MUST be the **whole** transcript in one
   *     value: no streaming, no chunking. Transcripts are a few MB and the
   *     host caps the decoded size (32 MB) and fails loudly above it; a
   *     streaming form would buy nothing at today's sizes and is a v2 concern.
   *   - `format` is a provider-owned tag (e.g. `claude-jsonl@1`) that the host
   *     stores and echoes back to {@link importSession} verbatim. Version it:
   *     it is the only thing that lets the receiving side refuse a payload it
   *     cannot resume.
   *   - Return `{ ok:false, error }` — do not throw — when the transcript is
   *     missing or unreadable. The message reaches a human.
   *   - Read-only: MUST NOT move, delete or rewrite the source. The host
   *     archives the local session itself, only after the far side has
   *     committed its copy.
   */
  exportSession(input: {
    providerSessionId: string
    /** Canonical cwd on THIS machine — the provider encodes its own layout. */
    projectPath: string
    /** Profile holding the transcript; omitted = the runtime's implicit default. */
    profileId?: string
  }): Promise<TranscriptExportResult>

  /**
   * Write one back under a fresh host-generated id, so a later `resume` finds
   * it.
   *
   * Contract:
   *   - MUST refuse a `format` it does not recognise with
   *     `{ ok:false, error }`, rather than write a file it cannot resume.
   *     That refusal is what makes a mismatched move fail loudly on arrival
   *     instead of producing a dead session someone discovers a turn later.
   *   - `content` is base64, exactly as {@link exportSession} produced it —
   *     single blob, no streaming.
   *   - MUST write under `newProviderSessionId` (host-generated, fresh on this
   *     machine) so the host's session↔transcript mapping stays unique;
   *     `projectPath` is the canonical cwd **on this machine**, which the
   *     provider encodes into its own layout. As with
   *     {@link ProfilesApi.transferSession}, `resume` is expected to key off
   *     the destination id, so no rewrite of ids inside the payload is
   *     required.
   *   - Return `{ ok:false, error }` — do not throw — on any failure, and
   *     leave nothing half-written behind: the host treats a failed import as
   *     "the move did not happen" and keeps the source session live.
   */
  importSession(input: {
    newProviderSessionId: string
    projectPath: string
    profileId?: string
    format: string
    content: string
  }): Promise<TranscriptImportResult>
}
