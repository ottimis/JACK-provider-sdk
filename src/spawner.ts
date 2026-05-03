/**
 * ProcessSpawner — abstraction over "how we get a running provider CLI
 * with stdin/stdout pipes attached". Consumed by every backend so they
 * don't need to know whether the process runs locally or inside a Docker
 * container.
 *
 * Design goals:
 *   - The shape matches the Anthropic SDK's `SpawnedProcess` / `SpawnOptions`
 *     exactly, so a single spawner can be fed to that SDK without
 *     translation. Other providers happily reuse the same shape.
 *   - The only Docker-aware code lives in the host's `docker/sandbox.ts`
 *     which exposes a `createDockerSpawner()` that returns a ProcessSpawner.
 *   - The host decides which spawner to use based on `session.sandboxed`
 *     and hands it to the provider via `AgentQueryOptions.spawner`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

/**
 * Minimal process handle that both `ChildProcess` (node) and the Anthropic
 * SDK's `SpawnedProcess` satisfy. Deliberately identical to the SDK
 * interface so that values of this type can be handed back to the SDK
 * verbatim.
 */
export interface ProcessHandle {
  stdin: Writable
  stdout: Readable
  readonly killed: boolean
  readonly exitCode: number | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  once(event: 'error', listener: (error: Error) => void): void
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  off(event: 'error', listener: (error: Error) => void): void
}

/**
 * Arguments handed to a spawner. Matches the Anthropic SDK `SpawnOptions`
 * shape so the same function can be plugged into `spawnClaudeCodeProcess`.
 */
export interface SpawnArgs {
  command: string
  args: string[]
  cwd?: string
  env: { [k: string]: string | undefined }
  signal: AbortSignal
}

export type ProcessSpawner = (args: SpawnArgs) => ProcessHandle

/**
 * Default local spawner — plain `child_process.spawn`. The returned
 * ChildProcess satisfies ProcessHandle because we pipe all three streams.
 */
export const localSpawner: ProcessSpawner = ({ command, args, cwd, env, signal }) => {
  const cp: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  signal.addEventListener('abort', () => {
    if (!cp.killed) {
      try { cp.kill('SIGTERM') } catch { /* ignore */ }
    }
  })
  return cp
}
