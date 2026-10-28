/**
 * Threadloom's Host-side session management service (M1: trash core).
 *
 * The pipeline is deliberately preflight-first: every check that can fail
 * (running work, migration state, write lease, on-disk location, occupied trash
 * destination) happens before the first directory move. Moves then happen in one
 * rollback-guarded phase.
 *
 * @module dsh-session-butler/host/service
 */

import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { ButlerError, asButlerError } from '../shared/errors.js'
import { subagentDescendants } from './lineage.js'
import { SessionLocator } from './locate.js'
import type {
  AgentsPort,
  SessionObservationLike,
  SessionPersistencePort,
  SessionQueryPort,
  SessionRecordLike,
  SessionsPort,
  WorkspaceRegistryPort,
} from './ports.js'
import { TrashStore, type TrashEntry } from './trash-store.js'

/** Construction dependencies; tests supply fakes and a temporary sessions root. */
export interface SessionButlerOptions {
  readonly sessionsRoot: string
  readonly trashRoot: string
  readonly query: SessionQueryPort
  readonly persistence: SessionPersistencePort
  /** Live services may be late-bound: pass a getter when activation order is unknown. */
  readonly sessions?: SessionsPort | (() => SessionsPort | undefined)
  readonly agents?: AgentsPort | (() => AgentsPort | undefined)
  /** Optional workspace services: absent in headless / ACP compositions. */
  readonly workspace?: WorkspaceRegistryPort | (() => WorkspaceRegistryPort | undefined)
  readonly retentionDays: number
  readonly cascadeSubagents: boolean
  readonly permanentDelete: 'disabled' | 'confirm'
  readonly now?: () => number
  /** How long to wait for `stopActivity` before refusing a running-session delete. */
  readonly liveSettleTimeoutMs?: number
}

/** Result of moving sessions into the trash. */
export interface TrashResult {
  readonly trashed: readonly string[]
  readonly trashRoot: string
}

/** Result of restoring one trashed session. */
export interface RestoreResult {
  readonly restored: string
  readonly path: string
}

/** Result of permanently removing one trashed session. */
export interface PurgeResult {
  readonly purged: string
}

/** One listed trash entry. */
export interface TrashListEntry {
  readonly id: string
  readonly deletedAt: number
  /** Unix epoch ms when retention expires, or null when retention is disabled. */
  readonly expiresAt: number | null
  /** Retention elapsed; purge remains a manual action (Q1). */
  readonly expired: boolean
  readonly cascadeOf?: string
  readonly descendants: readonly string[]
  readonly originalPath: string
  /** Header snapshot captured at deletion time. */
  readonly headerSnapshot: {
    readonly id: string
    readonly cwd?: string
    readonly createdAt?: number
    readonly parentSession?: string
    readonly origin?: 'subagent'
  }
}

/** Detail shown before a destructive action (and reusable by M3's tools). */
export interface SessionDetail {
  readonly id: string
  readonly headerSnapshot: {
    readonly id: string
    readonly cwd?: string
    readonly createdAt?: number
    readonly parentSession?: string
    readonly origin?: 'subagent'
  }
  readonly formatStatus?: 'current' | 'migration-required'
  /** Ids of subagent descendants that a cascade would also delete. */
  readonly descendantIds: readonly string[]
}

/** Trash listing plus unparsable leftovers. */
export interface TrashListResult {
  readonly entries: readonly TrashListEntry[]
  readonly orphans: number
  readonly trashRoot: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Release a potentially disposable observation without letting disposal mask a result. */
function releaseObservation(observation: SessionObservationLike): void {
  try {
    if (typeof observation.dispose === 'function') observation.dispose()
    else observation[Symbol.dispose]?.()
  } catch {
    // Observation disposal is best-effort; the read already succeeded or failed on its own.
  }
}

/** Map `sessionQuery` failures onto stable Threadloom codes. */
function queryFailure(error: unknown, context: string): ButlerError {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
    return new ButlerError('session-not-found', `${context}: session not found`, { cause: error })
  }
  return asButlerError(error, 'internal', context)
}

/** The M1 trash service exposed as `ctx.sessionButler`. */
export class SessionButlerService {
  private readonly locator: SessionLocator
  private readonly trashStore: TrashStore
  private readonly now: () => number

  /** Late-bound live lookups (see {@link SessionButlerOptions}). */
  private get sessions(): SessionsPort | undefined {
    return typeof this.options.sessions === 'function' ? this.options.sessions() : this.options.sessions
  }

  private get agents(): AgentsPort | undefined {
    return typeof this.options.agents === 'function' ? this.options.agents() : this.options.agents
  }

  private get workspace(): WorkspaceRegistryPort | undefined {
    return typeof this.options.workspace === 'function' ? this.options.workspace() : this.options.workspace
  }

  constructor(private readonly options: SessionButlerOptions) {
    this.locator = new SessionLocator(options.sessionsRoot)
    this.trashStore = new TrashStore(options.sessionsRoot, options.trashRoot)
    this.now = options.now ?? Date.now
  }

  /** Root directory of the trash (for diagnostics and the command surface). */
  get trashRoot(): string {
    return this.options.trashRoot
  }

  /** Read-only configuration snapshot for UIs (no secrets, no paths). */
  get config(): {
    readonly retentionDays: number
    readonly cascadeSubagents: boolean
    readonly permanentDelete: 'disabled' | 'confirm'
    readonly workspaceAvailable: boolean
  } {
    return {
      retentionDays: this.options.retentionDays,
      cascadeSubagents: this.options.cascadeSubagents,
      permanentDelete: this.options.permanentDelete,
      workspaceAvailable: this.workspace !== undefined,
    }
  }

  /**
   * Describe one live-or-cold session without activating an Agent.
   * @param sessionId - session to describe.
   * @returns header snapshot, format status and subagent descendants a cascade would include.
   */
  async detail(sessionId: string): Promise<SessionDetail> {
    const record = await this.readRootRecord(sessionId)
    const descendants = await this.readDescendants(sessionId)
    return {
      id: sessionId,
      headerSnapshot: {
        id: record.header.id,
        ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
        ...(record.header.createdAt === undefined ? {} : { createdAt: record.header.createdAt }),
        ...(record.header.parentSession === undefined ? {} : { parentSession: record.header.parentSession }),
        ...(record.header.origin === undefined ? {} : { origin: record.header.origin }),
      },
      ...(record.formatStatus === undefined ? {} : { formatStatus: record.formatStatus }),
      descendantIds: descendants.map(item => item.header.id),
    }
  }

  /** List trashed sessions. Expired entries are reported but never auto-purged (Q1). */
  async listTrash(): Promise<TrashListResult> {
    const listing = await this.trashStore.list()
    const now = this.now()
    const entries = listing.entries.map((entry): TrashListEntry => {
      const expiresAt = this.options.retentionDays > 0
        ? entry.meta.deletedAt + this.options.retentionDays * DAY_MS
        : null
      return {
        id: entry.meta.id,
        deletedAt: entry.meta.deletedAt,
        expiresAt,
        expired: expiresAt !== null && now >= expiresAt,
        ...(entry.meta.cascadeOf === undefined ? {} : { cascadeOf: entry.meta.cascadeOf }),
        descendants: entry.meta.descendants,
        originalPath: path.join(this.options.sessionsRoot, entry.meta.originalProject, entry.meta.originalDir),
        headerSnapshot: {
          id: entry.meta.header.id,
          ...(entry.meta.header.cwd === undefined ? {} : { cwd: entry.meta.header.cwd }),
          ...(entry.meta.header.createdAt === undefined ? {} : { createdAt: entry.meta.header.createdAt }),
          ...(entry.meta.header.parentSession === undefined ? {} : { parentSession: entry.meta.header.parentSession }),
          ...(entry.meta.header.origin === undefined ? {} : { origin: entry.meta.header.origin }),
        },
      }
    })
    return { entries, orphans: listing.orphans.length, trashRoot: this.options.trashRoot }
  }

  /**
   * Move one session (optionally with its subagent descendants) into the trash.
   * @param sessionId - session to trash.
   * @param options - `cascade` overrides the plugin default; `currentSessionId`
   *   refuses trashing the session issuing the command.
   * @throws {ButlerError} preflight or move failures; nothing is moved on preflight failure.
   */
  async trash(
    sessionId: string,
    options: { cascade?: boolean; currentSessionId?: string } = {},
  ): Promise<TrashResult> {
    if (options.currentSessionId === sessionId) {
      throw new ButlerError('cannot-trash-current', 'refusing to trash the current session')
    }
    const rootRecord = await this.readRootRecord(sessionId)
    if (rootRecord.formatStatus === 'migration-required') throw migrationError([sessionId])
    const cascade = options.cascade ?? this.options.cascadeSubagents
    const descendants = cascade ? await this.readDescendants(sessionId) : []
    const migrationBlocked = descendants
      .filter(record => record.formatStatus === 'migration-required')
      .map(record => record.header.id)
    if (migrationBlocked.length > 0) throw migrationError(migrationBlocked)

    const records: SessionRecordLike[] = [rootRecord, ...descendants]
    const archived: string[] = []
    let succeeded = false
    try {
      for (const record of records) await this.settleRunning(record.header.id, archived)
      for (const record of records) await this.probeLease(record.header.id)
      const located = await this.locator.locateAll(records)
      for (const target of located) await this.trashStore.assertFree(target)

      const deletedAt = this.now()
      const descendantIds = descendants.map(record => record.header.id)
      const moved: TrashEntry[] = []
      try {
        for (const target of located) {
          const isRoot = target.id === sessionId
          moved.push(await this.trashStore.moveIn(target, {
            deletedAt,
            ...(isRoot ? {} : { cascadeOf: sessionId }),
            descendants: isRoot ? descendantIds : [],
          }))
        }
      } catch (error) {
        for (const entry of [...moved].reverse()) {
          try {
            await this.trashStore.moveOut(entry)
          } catch {
            // Rollback is best-effort; the original failure stays authoritative.
          }
        }
        throw error
      }

      for (const target of located) await this.clearWorkspaceState(target.id)
      succeeded = true
      return { trashed: located.map(target => target.id), trashRoot: this.options.trashRoot }
    } finally {
      if (!succeeded) {
        for (const id of archived) {
          try {
            await this.workspace?.unarchiveSession(id)
          } catch {
            // Best-effort state restoration after a failed trash.
          }
        }
      }
    }
  }

  /** Restore one trashed session to its original directory. */
  async restore(sessionId: string): Promise<RestoreResult> {
    const entry = await this.trashStore.find(sessionId)
    if (entry === undefined) {
      throw new ButlerError('trash-not-found', `the trash holds no session "${sessionId}"`, {
        details: { sessionId },
      })
    }
    const restoredPath = await this.trashStore.moveOut(entry)
    return { restored: sessionId, path: restoredPath }
  }

  /**
   * Permanently remove one trashed session (Q2: disabled unless the profile opts
   * into `confirm`, and the caller must echo the exact session id).
   */
  async purge(sessionId: string, confirmId: string): Promise<PurgeResult> {
    if (this.options.permanentDelete !== 'confirm') {
      throw new ButlerError(
        'permanent-delete-disabled',
        'permanent deletion is disabled; set permanentDelete: confirm in the plugin config to enable it',
      )
    }
    if (confirmId !== sessionId) {
      throw new ButlerError('confirm-mismatch', 'permanent deletion requires the exact session id', {
        details: { sessionId },
      })
    }
    const entry = await this.trashStore.find(sessionId)
    if (entry === undefined) {
      throw new ButlerError('trash-not-found', `the trash holds no session "${sessionId}"`, {
        details: { sessionId },
      })
    }
    await this.trashStore.purge(entry)
    return { purged: sessionId }
  }

  /** Read the root record: header + format status, without activating an Agent. */
  private async readRootRecord(sessionId: string): Promise<SessionRecordLike & { formatStatus?: 'current' | 'migration-required' }> {
    let observation: SessionObservationLike
    try {
      observation = await this.options.query.observeSession(sessionId)
    } catch (error) {
      throw queryFailure(error, `cannot read session "${sessionId}"`)
    }
    try {
      const stats = await this.options.persistence.stat(sessionId)
      return {
        header: observation.header,
        live: this.isLive(sessionId),
        persisted: true,
        ...(stats?.formatStatus === undefined ? {} : { formatStatus: stats.formatStatus }),
      }
    } finally {
      releaseObservation(observation)
    }
  }

  /** Subagent descendants only (`origin === 'subagent'`), never ordinary forks. */
  private async readDescendants(sessionId: string): Promise<SessionRecordLike[]> {
    let trace
    try {
      trace = await this.options.query.traceSession(sessionId)
    } catch (error) {
      throw queryFailure(error, `cannot trace session "${sessionId}"`)
    }
    return subagentDescendants(trace)
  }

  /** Whether this process holds the session (live Session or Agent). */
  private isLive(sessionId: string): boolean {
    return this.sessions?.get(sessionId) !== undefined || this.agents?.get(sessionId) !== undefined
  }

  /**
   * Stop running work and wait for it to settle (D-013). Without workspace
   * services a running session is refused outright.
   * @param archived - collects ids this call archived, for failure rollback.
   */
  private async settleRunning(sessionId: string, archived: string[]): Promise<void> {
    if (!this.isLive(sessionId)) return
    const workspace = this.workspace
    if (workspace === undefined) {
      throw new ButlerError(
        'session-running',
        `session "${sessionId}" is running and this composition provides no workspace service to stop it; stop it first`,
        { details: { sessionId } },
      )
    }
    try {
      await workspace.archiveSession(sessionId, { stopActivity: true })
      archived.push(sessionId)
    } catch (error) {
      throw new ButlerError('session-running', `cannot stop running session "${sessionId}"`, {
        details: { sessionId },
        cause: error,
      })
    }
    const settleTimeoutMs = this.options.liveSettleTimeoutMs ?? 3_000
    const attempts = Math.max(1, Math.ceil(settleTimeoutMs / 100))
    for (let attempt = 0; attempt < attempts && this.isLive(sessionId); attempt += 1) {
      await sleep(100)
    }
    if (this.isLive(sessionId)) {
      throw new ButlerError('session-running', `session "${sessionId}" is still running after stop was requested`, {
        details: { sessionId },
      })
    }
  }

  /** Take and release the cross-process write lease once, as a writer probe. */
  private async probeLease(sessionId: string): Promise<void> {
    let handle
    try {
      handle = await this.options.persistence.open(sessionId, 'write')
    } catch (error) {
      throw new ButlerError('session-locked', `session "${sessionId}" is held by another writer`, {
        details: { sessionId },
        cause: error,
      })
    }
    try {
      await handle.close()
    } catch (error) {
      throw new ButlerError('session-locked', `cannot release the write probe for "${sessionId}"`, {
        details: { sessionId },
        cause: error,
      })
    }
  }

  /** Drop archived/pinned state after a successful move; best-effort by design. */
  private async clearWorkspaceState(sessionId: string): Promise<void> {
    const workspace = this.workspace
    if (workspace === undefined) return
    try {
      await workspace.unarchiveSession(sessionId)
    } catch {
      // Already unarchived and unknown ids are both acceptable here.
    }
    try {
      await workspace.unpinSession(sessionId)
    } catch {
      // Unpinning an unpinned id is a no-op failure at worst.
    }
  }
}

/** Build the migration-refusal error naming every blocked session. */
function migrationError(sessionIds: readonly string[]): ButlerError {
  return new ButlerError(
    'session-migration-required',
    `session format migration is required for ${sessionIds.map(id => `"${id}"`).join(', ')}; open it first to migrate, then retry`,
    { details: { sessionIds } },
  )
}
