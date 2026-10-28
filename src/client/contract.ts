/**
 * Minimal structural contracts for the Client half.
 *
 * As with the Host ports, the plugin does not import Harness Client packages at
 * runtime or build time; it relies on the audited surfaces instead (slots,
 * locale, session/workspace stores, uiWorkspace navigation). Every shape here
 * mirrors the rc.2 declarations listed in `research/dsh-session-management-v2.md`
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

/** The bridge's configuration snapshot. */
export interface BridgeStatus {
  readonly retentionDays: number
  readonly cascadeSubagents: boolean
  readonly permanentDelete: 'disabled' | 'confirm'
  readonly workspaceAvailable: boolean
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

/** Detail shown before a cascade delete. */
export interface SessionDetailLike {
  readonly id: string
  readonly headerSnapshot: {
    readonly id: string
    readonly cwd?: string
  }
  readonly formatStatus?: 'current' | 'migration-required'
  readonly descendantIds: readonly string[]
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
  readonly uiWorkspace: { openSession(sessionId: string): void }
  readonly sessions?: { refresh(): Promise<void> }
  effect(execute: () => (() => void) | void, label?: string): unknown
  logger?: { warn(message: string): void }
}
