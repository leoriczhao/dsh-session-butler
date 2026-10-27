/**
 * Structural ports for the subset of DSH Host services Threadloom uses.
 *
 * Why local structural types instead of importing `@deepseek-ai/dsh-*` types:
 * the plugin must keep working across the published rc channel (rc.2 / rc.3 /
 * rc.4) and avoid pinning implementation packages. Every port below was
 * audited against the `0.2.1-rc.2` release packages (see
 * `research/dsh-session-management-v2.md` §5.4); field names and signatures
 * mirror those declarations. At runtime the objects are the real Cordis
 * services fetched with `ctx.get(...)`.
 *
 * @module dsh-session-butler/host/ports
 */

/** Detached session identity metadata (rc.2 `dsh-session` SessionHeader). */
export interface SessionHeaderLike {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  /** Fork source id. Present on ordinary forks in published rc versions. */
  readonly parentSession?: string
  readonly isSeeded?: boolean
  /** Coarse classification for subagent children; only this value counts as lineage. */
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

/** One logical session record (rc.2 `dsh-session-query` SessionRecord). */
export interface SessionRecordLike {
  readonly header: SessionHeaderLike
  readonly live?: boolean
  readonly persisted?: boolean
  readonly formatStatus?: 'current' | 'migration-required'
}

/** One descendant tree node returned by `traceSession`. */
export interface SessionLineageNodeLike {
  readonly session: SessionRecordLike
  readonly descendants: readonly SessionLineageNodeLike[]
}

/** Result of `traceSession` (rc.2 `SessionLineageTrace`). */
export interface SessionLineageTraceLike {
  readonly target: SessionRecordLike
  readonly ancestors: readonly SessionRecordLike[]
  readonly descendants: readonly SessionLineageNodeLike[]
  readonly complete?: boolean
}

/** One live-preferred observation (rc.2 `SessionObservation`; dispose via Symbol). */
export interface SessionObservationLike {
  readonly header: SessionHeaderLike
  dispose?(): unknown
  readonly [Symbol.dispose]?: () => unknown
}

/** The `sessionQuery` methods Threadloom consumes. */
export interface SessionQueryPort {
  observeSession(sessionId: string, options?: { signal?: AbortSignal }): Promise<SessionObservationLike>
  traceSession(sessionId: string, signal?: AbortSignal): Promise<SessionLineageTraceLike>
}

/** The `sessionPersistence` methods Threadloom consumes. */
export interface SessionPersistencePort {
  open(sessionId: string, access: 'write', options?: { signal?: AbortSignal }): Promise<{ close(): Promise<void> }>
  stat(
    sessionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ formatStatus?: 'current' | 'migration-required'; sizeBytes?: number } | undefined>
}

/** Live-session lookup (`ctx.sessions.get`). */
export interface SessionsPort {
  get(sessionId: string): unknown
}

/** Live-agent lookup (`ctx.agents.get`). */
export interface AgentsPort {
  get(sessionId: string): unknown
}

/**
 * The workspace registry subset used to stop running work before a trash
 * operation and to drop archived/pinned state afterwards. Optional in the
 * composition: only the Web and SDK application bundles mount it.
 */
export interface WorkspaceRegistryPort {
  archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
  pinSession(sessionId: string): Promise<void>
  unpinSession(sessionId: string): Promise<void>
}

/** One `/session-butler` command result (rc.2 `CommandResult`). */
export type ButlerCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** Invocation subset the command handler consumes (rc.2 `CommandInvocation`). */
export interface ButlerCommandInvocation {
  readonly rawInput: string
  readonly agent?: { readonly session?: { readonly id?: string } }
}

/** One human command definition (rc.2 `CommandDefinition`). */
export interface ButlerCommandDefinition {
  readonly name: string
  readonly description: string
  readonly handler: (invocation: ButlerCommandInvocation) => ButlerCommandResult | Promise<ButlerCommandResult>
}

/** The `commands` registry subset Threadloom consumes. */
export interface CommandsPort {
  register(definition: ButlerCommandDefinition): () => void
}

/** Host context surface used by `apply` (Cordis `Context` subset). */
export interface ButlerHostContext {
  get<T>(name: string): T | undefined
  provide(name: string, value: unknown): () => void
  effect(execute: () => unknown, label?: string): unknown
  logger?: { warn(message: string): void }
}
