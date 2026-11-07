/**
 * Minimal structural contracts for the Client half.
 *
 * As with the Host ports, the plugin does not import Harness Client packages at
 * runtime or build time; it relies on the audited surfaces instead (slots,
 * locale, session/workspace stores, uiWorkspace navigation). Every shape here
 * mirrors the rc.2 declarations audited for this plugin
 * §5.4.
 *
 * @module dsh-session-butler/client/contract
 */

/** One session row as exposed by the Client session store. */
export interface SessionSummaryLike {
  readonly id: string
  readonly title?: string
  readonly displayTitle: string
  readonly cwd?: string
  readonly parentId?: string
  readonly origin?: 'subagent'
  readonly formatStatus?: 'current' | 'migration-required'
  readonly running: boolean
  readonly blank: boolean
  readonly updatedAt: number
}

/** One Client session list snapshot. */
export interface SessionListStateLike {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionSummaryLike>>
  readonly phase?: 'pending' | 'ready'
}

/** One workspace row exposed by the Client workspace store. */
export interface WorkspaceViewLike {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

/** One Client workspace snapshot. */
export interface WorkspaceSnapshotLike {
  readonly items: readonly WorkspaceViewLike[]
  readonly archivedSessionIds: readonly string[]
  readonly pinnedSessionIds: readonly string[]
  readonly state?: 'idle' | 'loading' | 'error'
}

/** One recent bridge failure included in the health snapshot. */
export interface BridgeErrorLike {
  readonly code: string
  readonly at: number
  readonly message?: string
}

/** The bridge's configuration and health snapshot. */
export interface BridgeStatus {
  readonly retentionDays: number
  readonly cascadeSubagents: boolean
  readonly permanentDelete: 'disabled' | 'confirm'
  readonly workspaceAvailable: boolean
  readonly ok?: boolean
  readonly version?: string
  readonly host?: { readonly ok: boolean; readonly error?: string }
  readonly bridge?: { readonly ok: boolean; readonly mounted: boolean }
  readonly storage?: {
    readonly trashWritable: boolean
    readonly sessionsRootWritable: boolean
    readonly trashCount: number
  }
  readonly backends?: {
    readonly sessionQuery: boolean
    readonly workspaceRegistry: boolean
    readonly sessionController: boolean
    readonly tools: boolean
  }
  readonly counts?: {
    readonly sessions: number
    readonly trashed: number
    readonly live: number
  }
  readonly errors?: readonly BridgeErrorLike[]
}

/** Configuration values the Client half reads from DSH settings. */
export interface ClientConfigLike {
  readonly inlineMenuEnabled?: boolean
  /** Pre-D3.0b field served by older Host schemas; read but never written by new code. */
  readonly panelEntryEnabled?: boolean
  readonly trashRetentionDays?: number
  readonly cascadeSubagents?: boolean
  readonly permanentDelete?: 'disabled' | 'confirm'
  readonly liveSettleTimeoutMs?: number
}

/** The DSH settings form snapshot for one plugin entry. */
export interface ConfigFormSnapshotLike<T> {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value?: T | undefined
  readonly revision?: number | undefined
  readonly writable: boolean
}

/** One field operation accepted by the DSH settings form. */
export interface ConfigPathOpLike {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

/** The DSH settings form for one plugin entry (client half of `configForms`). */
export interface ConfigFormLike<T> {
  getSnapshot(): ConfigFormSnapshotLike<T>
  subscribe(listener: () => void): () => void
  mutate(ops: readonly ConfigPathOpLike[], expectedRevision?: number): Promise<boolean>
  set(field: string, value: unknown): Promise<boolean>
}

/** The page form the Plugins page owner hands to a configuration slot. */
export interface ConfigPageFormLike {
  readonly state: ConfigFormSnapshotLike<Record<string, unknown>>
  mutate(ops: readonly ConfigPathOpLike[], expectedRevision?: number): Promise<boolean>
}

/** The `configForms` client service. */
export interface ConfigFormsLike {
  get<T>(entryId: string): ConfigFormLike<T>
}

/** One trashed session as returned by the Host bridge. */
export interface TrashEntryLike {
  readonly id: string
  readonly deletedAt: number
  readonly expiresAt: number | null
  readonly expired: boolean
  readonly cascadeOf?: string
  readonly descendants: readonly string[]
  readonly originalPath: string
  readonly headerSnapshot: {
    readonly id: string
    readonly cwd?: string
    readonly createdAt?: number
    readonly parentSession?: string
    readonly origin?: 'subagent'
  }
}

/** One lineage row returned by the Host read model. */
export interface LineageEntryLike {
  readonly id: string
  readonly cwd?: string
  readonly createdAt?: number
  readonly origin?: 'subagent'
  readonly agentPreset?: string
}

/** One lineage node with nested subagent descendants. */
export interface LineageNodeLike extends LineageEntryLike {
  readonly descendants: readonly LineageNodeLike[]
}

/** Aggregated log figures folded from raw events by the Host. */
export interface SessionStatsLike {
  readonly eventCount?: number
  readonly sizeBytes?: number
  readonly inheritedEventCount?: number
  readonly turns?: number
  readonly steps?: number
  readonly userMessages?: number
  readonly assistantMessages?: number
  readonly toolCalls?: number
  readonly toolResults?: number
  readonly lastActivityAt?: number
  readonly title?: string
  readonly tokens?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
  }
}

/** Enrichment availability reported by the Host. */
export interface DetailEnrichmentLike {
  readonly status: 'complete' | 'partial'
  readonly reason?: 'migration-required' | 'read-failed'
}

/** Detail shown before a cascade delete and in the detail dialog. */
export interface SessionDetailLike {
  readonly id: string
  readonly headerSnapshot: {
    readonly id: string
    readonly cwd?: string
    readonly createdAt?: number
    readonly parentSession?: string
    readonly origin?: 'subagent'
    readonly isSeeded?: boolean
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
  readonly formatStatus?: 'current' | 'migration-required'
  readonly live: boolean
  readonly descendantIds: readonly string[]
  readonly enrichment: DetailEnrichmentLike
  readonly stats?: SessionStatsLike
  readonly lineage: {
    readonly complete: boolean
    readonly missingParentId?: string
    readonly ancestors: readonly LineageEntryLike[]
    readonly descendants: readonly LineageNodeLike[]
  }
}

/** One item outcome from a Host batch operation. */
export interface BatchItemResultLike {
  readonly id: string
  readonly ok: boolean
  readonly moved: readonly string[]
  readonly error?: { readonly code: string; readonly message: string }
}

/** Aggregate result of a Host batch operation. */
export interface BatchResultLike {
  readonly items: readonly BatchItemResultLike[]
  readonly moved: readonly string[]
  readonly failed: readonly string[]
}

/** Actions injected into the registered slot entries. */
export interface PageActions {
  call<T>(method: string, payload?: unknown): Promise<T>
  openSession(sessionId: string): void
  refreshSessions(): void
}

/** Props delivered to the management page by the slot framework + injected actions. */
export interface SessionButlerPageProps extends PageActions {
  useSessions<T>(select: (state: SessionListStateLike) => T): T
  useWorkspaces<T>(select: (state: WorkspaceSnapshotLike) => T): T
  t(key: string, vars?: Record<string, string | number>): string
}

/** Slot registration options shared by the main panel and sidebar row. */
export interface SlotRegistrationLike {
  readonly name: string
  readonly key?: string
  readonly id?: string
  readonly order?: number
  readonly label?: string | (() => string)
  readonly locale?: string
  readonly inject?: () => object
}

/** The Client context subset the plugin uses. */
export interface ClientContextLike {
  readonly locale: {
    register(namespace: string, locale: string, dict: Readonly<Record<string, string>>): () => void
    bind(namespace: string): (key: string, vars?: Record<string, string | number>) => string
  }
  readonly slots: {
    inject(name: string, callback: () => (() => void) | void): () => void
    register(options: SlotRegistrationLike, component: (props: never) => unknown): () => void
  }
  readonly uiWorkspace: {
    openSession(sessionId: string): void
    /** Official archive/unarchive commands; absent in test doubles. */
    archiveSession?(sessionId: string): Promise<void>
    unarchiveSession?(sessionId: string): Promise<void>
  }
  readonly sessions?: { refresh(): Promise<void> }
  /** Cordis service lookup; used for optional services like `configForms`. */
  get?(name: string): unknown
  effect(execute: () => (() => void) | void, label?: string): unknown
  logger?: { warn(message: string): void }
}
