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

/** One cloned raw session event (only the fields Threadloom reads). */
export interface SessionEventLike {
  readonly type?: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

/** One live-preferred observation (rc.2 `SessionObservation`; dispose via Symbol). */
export interface SessionObservationLike {
  readonly header: SessionHeaderLike
  /** Fork-inherited prefix length, when reported. */
  readonly inheritedEventCount?: number
  /** Last observed event seq, or -1 for an empty log. */
  readonly cursor?: number
  /** Complete raw log; only materialized after a reader asks for it. */
  readonly events?: readonly SessionEventLike[]
  dispose?(): unknown
  readonly [Symbol.dispose]?: () => unknown
}

/** One successful title observation (rc.2 `SessionTitleObservationResult`). */
export interface SessionTitleObservationLike {
  readonly sessionId: string
  readonly status: 'fulfilled' | 'rejected'
  readonly value?: {
    readonly session: SessionHeaderLike
    readonly title?: { readonly title?: string; readonly updatedAt?: number }
  }
}

/** The `sessionQuery` methods Threadloom consumes. */
export interface SessionQueryPort {
  observeSession(sessionId: string, options?: { signal?: AbortSignal; projectionMode?: 'all' | 'none' }): Promise<SessionObservationLike>
  traceSession(sessionId: string, signal?: AbortSignal): Promise<SessionLineageTraceLike>
  /** Batch title read; absent on compositions whose query service predates it. */
  readTitleSnapshots?(
    sessionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly SessionTitleObservationLike[]>
}

/** One stored-session snapshot (rc.2 `SessionPersistenceSnapshot`). */
export interface SessionPersistenceSnapshotLike {
  readonly header: SessionHeaderLike
  readonly formatStatus?: 'current' | 'migration-required'
  readonly eventCount?: number
  readonly sizeBytes?: number
}

/** The `sessionPersistence` methods Threadloom consumes. */
export interface SessionPersistencePort {
  open(sessionId: string, access: 'write', options?: { signal?: AbortSignal }): Promise<{ close(): Promise<void> }>
  stat(
    sessionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SessionPersistenceSnapshotLike | undefined>
  /** Every stored session visible to this process, in no promised order. */
  list(options?: { signal?: AbortSignal }): Promise<readonly SessionPersistenceSnapshotLike[]>
}

/** One live Session object (only the fields Threadloom reads). */
export interface LiveSessionLike {
  readonly id?: string
  readonly header?: SessionHeaderLike
}

/** Live-session access (`ctx.sessions`). */
export interface SessionsPort {
  get(sessionId: string): unknown
  list?(): readonly (LiveSessionLike | unknown)[]
}

/** One live Agent object (only the fields Threadloom reads). */
export interface LiveAgentLike {
  readonly sessionId?: string
  readonly status?: string
}

/** Live-agent access (`ctx.agents`). */
export interface AgentsPort {
  get(sessionId: string): unknown
  list?(): readonly (LiveAgentLike | unknown)[]
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
  /** Logical archive set; absent on compositions whose registry predates the getter. */
  readonly archivedSessionIds?: readonly string[]
  readonly pinnedSessionIds?: readonly string[]
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

/** One Host HTTP route (rc.2 `dsh-host-webserver` WebRoute, node:http handler). */
export interface HostWebRoute {
  readonly kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  readonly path: string
  handler(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void | Promise<void>
}

/** The `webServer` Host service subset Threadloom consumes. */
export interface WebServerPort {
  register(route: HostWebRoute): () => void
}

/**
 * The `connection` Host service subset used to admit only authenticated
 * same-origin browser requests (rc.2 `ConnectionTrustRequest` / 401|403|undefined).
 */
export interface ConnectionPort {
  requestRejection(request: { headers: import('node:http').IncomingHttpHeaders }): 401 | 403 | undefined
}

/** One author-facing tool parameter (rc.2 `ParameterSchemaSpec` property). */
export interface ButlerToolParameter {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  readonly description?: string
  readonly required?: true
  readonly enum?: readonly (string | number | boolean | null)[]
  readonly items?: ButlerToolParameter
  readonly properties?: Readonly<Record<string, ButlerToolParameter>>
  readonly additionalProperties?: boolean
}

/** One model-facing tool result block. */
export interface ButlerToolTextContent {
  readonly type: 'text'
  readonly text: string
}

/**
 * One model-facing tool definition, structurally compatible with rc.2
 * `ToolDefinition`. Threadloom builds this without importing `@deepseek-ai/dsh-tools`,
 * mirroring how published third-party plugins register tools.
 */
export interface ButlerToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, ButlerToolParameter>>
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>
    render(args: unknown, value: unknown): readonly ButlerToolTextContent[]
  }
  execute(args: unknown, exec: { readonly signal?: AbortSignal }): unknown
}

/** The `tools` registry subset Threadloom consumes. */
export interface ToolsPort {
  register(definition: ButlerToolDefinition): () => void
}

/** Host context surface used by `apply` (Cordis `Context` subset). */
export interface ButlerHostContext {
  get<T>(name: string): T | undefined
  provide(name: string, value: unknown): () => void
  effect(execute: () => unknown, label?: string): unknown
  /** Optional-service injection: the callback runs when every named service exists. */
  inject?(names: readonly string[], callback: (scope: ButlerHostContext) => unknown): unknown
  logger?: { warn(message: string): void }
}
