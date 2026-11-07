/**
 * the plugin's Host-side session management service (M1: trash core).
 *
 * The pipeline is deliberately preflight-first: every check that can fail
 * (running work, migration state, write lease, on-disk location, occupied trash
 * destination) happens before the first directory move. Moves then happen in one
 * rollback-guarded phase.
 *
 * @module dsh-session-butler/host/service
 */

import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { ButlerError, asButlerError } from '../shared/errors.js'
import { subagentDescendants } from './lineage.js'
import { SessionLocator } from './locate.js'
import type {
  AgentsPort,
  LiveAgentLike,
  LiveSessionLike,
  SessionHeaderLike,
  SessionLineageTraceLike,
  SessionObservationLike,
  SessionPersistencePort,
  SessionPersistenceSnapshotLike,
  SessionQueryPort,
  SessionRecordLike,
  SessionsPort,
  WorkspaceRegistryPort,
} from './ports.js'
import {
  lineageView,
  summarizeSessionEvents,
  type LineageEntry,
  type LineageNode,
  type SessionEventStats,
  type SessionListEntry,
  type SessionListFilters,
  type SessionListResult,
} from './read-model.js'
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
  /** Volatile configuration values are passed as getters so settings edits apply without a remount. */
  readonly retentionDays: number | (() => number)
  readonly cascadeSubagents: boolean | (() => boolean)
  readonly permanentDelete: 'disabled' | 'confirm' | (() => 'disabled' | 'confirm')
  readonly now?: () => number
  /** How long to wait for a loaded session to be released before refusing deletion. */
  readonly liveSettleTimeoutMs?: number | (() => number)
  /** Installed package version, shown in the health snapshot. */
  readonly pluginVersion?: string
  /** Capabilities the composition provides beyond this service's own ports. */
  readonly capabilities?: () => ButlerCapabilities
}

/** Optional registries reported by the health snapshot. */
export interface ButlerCapabilities {
  readonly workspaceRegistry?: boolean
  readonly sessionController?: boolean
  readonly tools?: boolean
  readonly commands?: boolean
}

/** One recent bridge/domain error kept for diagnostics. */
export interface ButlerErrorRecord {
  readonly code: string
  readonly at: number
  readonly message?: string
}

/** Functional health snapshot shared by the web page and the plugin manager. */
export interface ButlerHealth {
  readonly retentionDays: number
  readonly cascadeSubagents: boolean
  readonly permanentDelete: 'disabled' | 'confirm'
  readonly workspaceAvailable: boolean
  readonly ok: boolean
  readonly version: string
  readonly host: { readonly ok: boolean; readonly error?: string }
  readonly bridge: { readonly ok: boolean; readonly mounted: boolean }
  readonly storage: {
    readonly trashWritable: boolean
    readonly sessionsRootWritable: boolean
    readonly trashCount: number
  }
  readonly backends: {
    readonly sessionQuery: boolean
    readonly workspaceRegistry: boolean
    readonly sessionController: boolean
    readonly tools: boolean
    readonly commands: boolean
  }
  readonly counts: {
    readonly sessions: number
    readonly trashed: number
    readonly live: number
  }
  readonly errors: readonly ButlerErrorRecord[]
}

/** Probe one directory for write access, optionally creating it first. */
function directoryWritable(target: string, create: boolean): boolean {
  try {
    if (create) mkdirSync(target, { recursive: true })
    accessSync(target, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
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

/** Result of a permanent deletion (cold sessions are purged immediately). */
export interface DeleteResult {
  readonly deleted: readonly string[]
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

/** One structural header snapshot (stable subset of the session header). */
export interface SessionHeaderSnapshot {
  readonly id: string
  readonly cwd?: string
  readonly createdAt?: number
  readonly parentSession?: string
  readonly origin?: 'subagent'
  readonly isSeeded?: boolean
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

/** Enrichment outcome: `partial` means the header/lineage are present but log figures are not. */
export interface DetailEnrichment {
  readonly status: 'complete' | 'partial'
  /** Why enrichment is partial: migration under way or the log could not be read. */
  readonly reason?: 'migration-required' | 'read-failed'
}

/** Detail shown before a destructive action and by the read-only tools. */
export interface SessionDetail {
  readonly id: string
  readonly headerSnapshot: SessionHeaderSnapshot
  readonly formatStatus?: 'current' | 'migration-required'
  /** A live Session or Agent belongs to this process. */
  readonly live: boolean
  /** Ids of subagent descendants that a cascade would also delete. */
  readonly descendantIds: readonly string[]
  readonly enrichment: DetailEnrichment
  /** Log-derived figures; absent when enrichment is unavailable. */
  readonly stats?: Partial<SessionEventStats> & {
    readonly eventCount?: number
    readonly sizeBytes?: number
    readonly inheritedEventCount?: number
  }
  readonly lineage: {
    readonly complete: boolean
    readonly missingParentId?: string
    readonly ancestors: readonly LineageEntry[]
    readonly descendants: readonly LineageNode[]
  }
}

/** One item in a batch operation result. */
export interface BatchItemResult {
  readonly id: string
  readonly ok: boolean
  /** Sessions this item actually moved (includes cascade descendants). */
  readonly moved: readonly string[]
  readonly error?: { readonly code: string; readonly message: string }
}

/** Result of a batch trash or restore. */
export interface BatchResult {
  readonly items: readonly BatchItemResult[]
  readonly moved: readonly string[]
  readonly failed: readonly string[]
}

/** Hard upper bound on one batch request. */
const MAX_BATCH_SIZE = 50

/** Trash listing plus unparsable leftovers. */
export interface TrashListResult {
  readonly entries: readonly TrashListEntry[]
  readonly orphans: number
  readonly trashRoot: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Project one header into the stable snapshot subset. */
function snapshotHeader(header: SessionHeaderLike): SessionHeaderSnapshot {
  return {
    id: header.id,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.createdAt === undefined ? {} : { createdAt: header.createdAt }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.isSeeded === undefined ? {} : { isSeeded: header.isSeeded }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

/** Narrow a live Session value returned by `ctx.sessions.list()`. */
function liveSessionHeader(value: unknown): SessionHeaderLike | undefined {
  const record = value as { header?: unknown } | undefined
  const header = record?.header as SessionHeaderLike | undefined
  return header !== undefined && typeof header.id === 'string' && typeof header.createdAt === 'number'
    ? header
    : undefined
}

/** Narrow one live Agent value returned by `ctx.agents.list()`. */
function liveAgentSessionId(value: unknown): string | undefined {
  const record = value as { sessionId?: unknown } | undefined
  return typeof record?.sessionId === 'string' ? record.sessionId : undefined
}

/** Release a potentially disposable observation without letting disposal mask a result. */
function releaseObservation(observation: SessionObservationLike): void {
  try {
    if (typeof observation.dispose === 'function') observation.dispose()
    else observation[Symbol.dispose]?.()
  } catch {
    // Observation disposal is best-effort; the read already succeeded or failed on its own.
  }
}

/** Map `sessionQuery` failures onto stable the plugin codes. */
function queryFailure(error: unknown, context: string): ButlerError {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
    return new ButlerError('session-not-found', `${context}: session not found`, { cause: error })
  }
  return asButlerError(error, 'internal', context)
}

/** The M1 trash service exposed as `ctx.sessionButler`. */
export class SessionButlerService {
  private readonly recentErrors: ButlerErrorRecord[] = []
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

  /** Current retention window; read live because the settings form edits a Volatile handle. */
  private get retentionDays(): number {
    return typeof this.options.retentionDays === 'function' ? this.options.retentionDays() : this.options.retentionDays
  }

  /** Current cascade default; read live for the same reason. */
  private get cascadeSubagents(): boolean {
    return typeof this.options.cascadeSubagents === 'function' ? this.options.cascadeSubagents() : this.options.cascadeSubagents
  }

  /** Current permanent-delete policy; read live for the same reason. */
  private get permanentDelete(): 'disabled' | 'confirm' {
    return typeof this.options.permanentDelete === 'function' ? this.options.permanentDelete() : this.options.permanentDelete
  }

  /** Current settle timeout; read live for the same reason. */
  private get liveSettleTimeoutMs(): number {
    if (typeof this.options.liveSettleTimeoutMs === 'function') return this.options.liveSettleTimeoutMs()
    return this.options.liveSettleTimeoutMs ?? 3_000
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
      retentionDays: this.retentionDays,
      cascadeSubagents: this.cascadeSubagents,
      permanentDelete: this.permanentDelete,
      workspaceAvailable: this.workspace !== undefined,
    }
  }

  /** Keep the most recent bridge/domain failures for the health snapshot. */
  recordError(code: string, message?: string): void {
    this.recentErrors.push({
      code,
      at: this.now(),
      ...(message === undefined ? {} : { message }),
    })
    if (this.recentErrors.length > 20) this.recentErrors.shift()
  }

  /**
   * Build the functional health snapshot shown on the management page and in
   * the DSH Plugins page.
   *
   * Counts and storage probes are best-effort: an unreachable persistence
   * service must not make the snapshot itself fail, because the snapshot is the
   * surface used to diagnose exactly that condition.
   * @returns the current health facts, including the last 20 recorded errors.
   */
  async health(): Promise<ButlerHealth> {
    let sessions = 0
    try {
      sessions = (await this.options.persistence.list()).length
    } catch {
      // Reported as a zero count; the page still loads and shows other facts.
    }
    let trashed = 0
    try {
      trashed = (await this.trashStore.list()).entries.length
    } catch {
      // Same contract as the session count.
    }
    let live = 0
    try {
      live = this.sessions?.list?.().length ?? 0
    } catch {
      live = 0
    }
    const storage = {
      trashWritable: directoryWritable(this.options.trashRoot, true),
      sessionsRootWritable: directoryWritable(this.options.sessionsRoot, false),
      trashCount: trashed,
    }
    const caps = this.options.capabilities?.() ?? {}
    const backends = {
      sessionQuery: true,
      workspaceRegistry: caps.workspaceRegistry ?? this.workspace !== undefined,
      sessionController: caps.sessionController ?? false,
      tools: caps.tools ?? false,
      commands: caps.commands ?? false,
    }
    const ok = storage.trashWritable && storage.sessionsRootWritable
    return {
      ...this.config,
      ok,
      version: this.options.pluginVersion ?? 'unknown',
      host: { ok: true },
      bridge: { ok: true, mounted: true },
      storage,
      backends,
      counts: { sessions, trashed, live },
      errors: [...this.recentErrors],
    }
  }

  /**
   * Describe one live-or-cold session without activating an Agent.
   *
   * The header and format status come from persistence metadata so a session
   * awaiting migration is still describable; log-derived figures are added on a
   * best-effort basis and reported as partial when that read is unavailable.
   * @param sessionId - session to describe.
   * @returns header snapshot, format status, subagent descendants, log figures, and lineage.
   */
  async detail(sessionId: string): Promise<SessionDetail> {
    const stored = await this.statOrNotFound(sessionId)
    const { trace, lineage } = await this.readLineage(sessionId)
    const base = {
      id: sessionId,
      headerSnapshot: snapshotHeader(stored.header),
      ...(stored.formatStatus === undefined ? {} : { formatStatus: stored.formatStatus }),
      live: this.isLive(sessionId),
      descendantIds: subagentDescendants(trace).map(item => item.header.id),
      enrichment: { status: 'complete' as const },
      lineage,
    }
    const metadata: { eventCount?: number; sizeBytes?: number } = {
      ...(stored.eventCount === undefined ? {} : { eventCount: stored.eventCount }),
      ...(stored.sizeBytes === undefined ? {} : { sizeBytes: stored.sizeBytes }),
    }
    if (stored.formatStatus === 'migration-required') {
      return {
        ...base,
        enrichment: { status: 'partial', reason: 'migration-required' },
        ...(Object.keys(metadata).length === 0 ? {} : { stats: metadata }),
      }
    }
    let observation: SessionObservationLike | undefined
    try {
      observation = await this.options.query.observeSession(sessionId, { projectionMode: 'none' })
      const observedEvents = observation.events ?? []
      const stats = {
        ...summarizeSessionEvents(observedEvents),
        // `stat()` may omit eventCount (history-dependent); the observed log is
        // then the best available count and matches what the detail renderer shows.
        ...(stored.eventCount === undefined ? { eventCount: observedEvents.length } : {}),
        ...metadata,
        ...(observation.inheritedEventCount === undefined ? {} : { inheritedEventCount: observation.inheritedEventCount }),
      }
      return {
        ...base,
        headerSnapshot: snapshotHeader(observation.header),
        stats,
      }
    } catch {
      return {
        ...base,
        enrichment: { status: 'partial', reason: 'read-failed' },
        ...(Object.keys(metadata).length === 0 ? {} : { stats: metadata }),
      }
    } finally {
      if (observation !== undefined) releaseObservation(observation)
    }
  }

  /**
   * List the logical session corpus (live-preferred) newest first.
   *
   * Titles are read in one batch for the returned page only; a session whose
   * title fold fails keeps `title` absent instead of failing the listing.
   * @param filters - optional text/workspace filters and page size.
   * @returns the page plus the pre-limit match count.
   */
  async listSessions(filters: SessionListFilters = {}): Promise<SessionListResult> {
    const limit = Math.min(100, Math.max(1, Math.trunc(filters.limit ?? 25)))
    const persisted = await this.options.persistence.list()
    const byId = new Map<string, { header: SessionHeaderLike; formatStatus?: 'current' | 'migration-required' }>()
    for (const snapshot of persisted) {
      byId.set(snapshot.header.id, {
        header: snapshot.header,
        ...(snapshot.formatStatus === undefined ? {} : { formatStatus: snapshot.formatStatus }),
      })
    }
    for (const live of this.sessions?.list?.() ?? []) {
      const header = liveSessionHeader(live)
      if (header !== undefined && !byId.has(header.id)) byId.set(header.id, { header })
    }
    for (const agent of this.agents?.list?.() ?? []) {
      const id = liveAgentSessionId(agent)
      if (id !== undefined && !byId.has(id)) {
        // An Agent without a Session listing entry still means the id is live.
        byId.set(id, { header: { id, createdAt: 0 } as SessionHeaderLike })
      }
    }
    const archived = new Set(this.workspace?.archivedSessionIds ?? [])
    const pinned = new Set(this.workspace?.pinnedSessionIds ?? [])
    const query = filters.query?.trim().toLowerCase()
    const cwdFilter = filters.cwd?.trim().toLowerCase()
    const includeArchived = filters.includeArchived === true
    const archivedOnly = filters.archivedOnly === true
    const includeSubagents = filters.includeSubagents !== false
    const rows = [...byId.values()].filter((row) => {
      const { header } = row
      const subagent = header.origin === 'subagent'
      if (subagent && !includeSubagents) return false
      if (archivedOnly && !archived.has(header.id)) return false
      if (!includeArchived && !archivedOnly && archived.has(header.id)) return false
      if (cwdFilter !== undefined && (header.cwd ?? '').toLowerCase().startsWith(cwdFilter) === false) return false
      if (query !== undefined) {
        const haystack = `${header.id}\n${header.cwd ?? ''}`.toLowerCase()
        if (!haystack.includes(query)) return false
      }
      return true
    })
    rows.sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0))
    const page = rows.slice(0, limit)
    const titles = await this.readTitles(page.map(row => row.header.id))
    const sessions = page.map((row): SessionListEntry => {
      const { header } = row
      const title = titles.get(header.id)
      return {
        id: header.id,
        createdAt: header.createdAt,
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        ...(title === undefined ? {} : { title }),
        archived: archived.has(header.id),
        pinned: pinned.has(header.id),
        subagent: header.origin === 'subagent',
        ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
        ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
        ...(row.formatStatus === undefined ? {} : { formatStatus: row.formatStatus }),
        live: this.isLive(header.id),
      }
    })
    return { sessions, total: rows.length, truncated: rows.length > sessions.length }
  }

  /**
   * Trash several sessions independently; one failure does not stop the rest.
   * @param sessionIds - ids to trash (deduplicated, at most 50).
   * @param options - cascade/current-session guards applied to each item.
   * @returns per-item outcomes and the union of moved ids.
   */
  async trashMany(
    sessionIds: readonly string[],
    options: { cascade?: boolean; currentSessionId?: string } = {},
  ): Promise<BatchResult> {
    const ids = this.normalizeBatch(sessionIds)
    const moved = new Set<string>()
    const items: BatchItemResult[] = []
    for (const id of ids) {
      if (moved.has(id)) {
        items.push({ id, ok: true, moved: [] })
        continue
      }
      try {
        const result = await this.trash(id, options)
        for (const item of result.trashed) moved.add(item)
        items.push({ id, ok: true, moved: result.trashed })
      } catch (error) {
        const failure = asButlerError(error, 'internal', `cannot trash session "${id}"`)
        items.push({ id, ok: false, moved: [], error: { code: failure.code, message: failure.message } })
      }
    }
    return { items, moved: [...moved], failed: items.filter(item => !item.ok).map(item => item.id) }
  }

  /**
   * Restore several trashed sessions independently.
   * @param sessionIds - ids to restore (deduplicated, at most 50).
   * @returns per-item outcomes and the union of restored ids.
   */
  async restoreMany(sessionIds: readonly string[]): Promise<BatchResult> {
    const ids = this.normalizeBatch(sessionIds)
    const moved = new Set<string>()
    const items: BatchItemResult[] = []
    for (const id of ids) {
      try {
        const result = await this.restore(id)
        moved.add(result.restored)
        items.push({ id, ok: true, moved: [result.restored] })
      } catch (error) {
        const failure = asButlerError(error, 'internal', `cannot restore session "${id}"`)
        items.push({ id, ok: false, moved: [], error: { code: failure.code, message: failure.message } })
      }
    }
    return { items, moved: [...moved], failed: items.filter(item => !item.ok).map(item => item.id) }
  }

  /** Validate and deduplicate one batch id list. */
  private normalizeBatch(sessionIds: readonly string[]): string[] {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new ButlerError('invalid-request', 'a batch operation needs at least one session id')
    }
    if (sessionIds.length > MAX_BATCH_SIZE) {
      throw new ButlerError('invalid-request', `a batch operation accepts at most ${MAX_BATCH_SIZE} session ids`)
    }
    const seen = new Set<string>()
    const ids: string[] = []
    for (const value of sessionIds) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new ButlerError('invalid-request', 'every batch item must be a non-empty session id string')
      }
      if (seen.has(value)) continue
      seen.add(value)
      ids.push(value)
    }
    return ids
  }

  /** Read persistence metadata, or fail with the stable not-found code. */
  private async statOrNotFound(sessionId: string): Promise<SessionPersistenceSnapshotLike> {
    let stored: SessionPersistenceSnapshotLike | undefined
    try {
      stored = await this.options.persistence.stat(sessionId)
    } catch (error) {
      throw asButlerError(error, 'internal', `cannot read session "${sessionId}"`)
    }
    if (stored === undefined) {
      throw new ButlerError('session-not-found', `session "${sessionId}" was not found`, {
        details: { sessionId },
      })
    }
    return stored
  }

  /** Trace lineage once and project it into the read model. */
  private async readLineage(sessionId: string): Promise<{
    trace: SessionLineageTraceLike
    lineage: SessionDetail['lineage']
  }> {
    let trace: SessionLineageTraceLike
    try {
      trace = await this.options.query.traceSession(sessionId)
    } catch (error) {
      throw queryFailure(error, `cannot trace session "${sessionId}"`)
    }
    return { trace, lineage: lineageView(trace) }
  }

  /** Batch-read titles for one page; failures leave titles absent. */
  private async readTitles(sessionIds: readonly string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>()
    const read = this.options.query.readTitleSnapshots
    if (read === undefined || sessionIds.length === 0) return titles
    try {
      const results = await read.call(this.options.query, sessionIds)
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        const title = result.value?.title?.title
        if (typeof title === 'string' && title.length > 0) titles.set(result.sessionId, title)
      }
    } catch {
      // Titles are an enhancement; a batch title failure never fails the listing.
    }
    return titles
  }

  /** List trashed sessions. Expired entries are reported but never auto-purged (Q1). */
  async listTrash(): Promise<TrashListResult> {
    const listing = await this.trashStore.list()
    const now = this.now()
    const entries = listing.entries.map((entry): TrashListEntry => {
      const expiresAt = this.retentionDays > 0
        ? entry.meta.deletedAt + this.retentionDays * DAY_MS
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
    const cascade = options.cascade ?? this.cascadeSubagents
    const descendants = cascade ? await this.readDescendants(sessionId) : []
    const migrationBlocked = descendants
      .filter(record => record.formatStatus === 'migration-required')
      .map(record => record.header.id)
    if (migrationBlocked.length > 0) throw migrationError(migrationBlocked)

    const records: SessionRecordLike[] = [rootRecord, ...descendants]
    for (const record of records) await this.waitForRelease(record.header.id)
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
    return { trashed: located.map(target => target.id), trashRoot: this.options.trashRoot }
  }

  /**
   * Permanently delete one session (UI "Delete"): the safe trash pipeline moves
   * the files out of the corpus, then the trash entry is purged immediately, so
   * no user-visible trash entry remains. The `permanentDelete` config is not
   * consulted: the caller has already shown an irreversible-action confirmation.
   * @param sessionId - session to delete.
   * @param options - cascade/current-session guards.
   * @returns ids removed from the corpus (root + cascaded descendants).
   */
  async delete(
    sessionId: string,
    options: { cascade?: boolean; currentSessionId?: string } = {},
  ): Promise<DeleteResult> {
    if (options.currentSessionId === sessionId) {
      throw new ButlerError('cannot-trash-current', 'refusing to delete the current session')
    }
    const rootRecord = await this.readRootRecord(sessionId)
    if (rootRecord.formatStatus === 'migration-required') throw migrationError([sessionId])
    const cascade = options.cascade ?? this.cascadeSubagents
    const descendants = cascade ? await this.readDescendants(sessionId) : []
    const migrationBlocked = descendants
      .filter(record => record.formatStatus === 'migration-required')
      .map(record => record.header.id)
    if (migrationBlocked.length > 0) throw migrationError(migrationBlocked)

    // Refuse while this process still holds the session: the plugin cannot
    // release another owner's write handle, and deleting underneath a live
    // Agent would corrupt the log that owner keeps writing.
    for (const record of [rootRecord, ...descendants]) this.assertNotLoaded(record.header.id)

    const moved = await this.trash(sessionId, options)
    const deleted: string[] = []
    for (const id of moved.trashed) {
      const entry = await this.trashStore.find(id)
      if (entry === undefined) continue
      await this.trashStore.purge(entry)
      deleted.push(id)
    }
    return { deleted }
  }

  /**
   * Refuse a session this process still holds.
   * @param sessionId - session being deleted.
   * @throws {ButlerError} `session-running` for an active turn, else `session-in-use`.
   */
  private assertNotLoaded(sessionId: string): void {
    if (!this.isLive(sessionId)) return
    const agent = this.agents?.get(sessionId) as LiveAgentLike | undefined
    if (agent?.status === 'running') {
      throw new ButlerError(
        'session-running',
        'session "' + sessionId + '" is still running; stop its activity before retrying',
        { details: { sessionId } },
      )
    }
    throw new ButlerError(
      'session-in-use',
      'session "' + sessionId + '" is still loaded in this DSH process; release it before retrying',
      { details: { sessionId } },
    )
  }

  /**
   * Permanently delete several sessions independently; one failure does not stop
   * the rest. Items report their deleted ids in `moved` (same batch envelope as
   * trash/restore); ids already removed by a cascade are no-op successes.
   */
  async deleteMany(
    sessionIds: readonly string[],
    options: { cascade?: boolean; currentSessionId?: string } = {},
  ): Promise<BatchResult> {
    const ids = this.normalizeBatch(sessionIds)
    const deleted = new Set<string>()
    const items: BatchItemResult[] = []
    for (const id of ids) {
      if (deleted.has(id)) {
        items.push({ id, ok: true, moved: [] })
        continue
      }
      try {
        const result = await this.delete(id, options)
        for (const item of result.deleted) deleted.add(item)
        items.push({ id, ok: true, moved: result.deleted })
      } catch (error) {
        const failure = asButlerError(error, 'internal', `cannot delete session "${id}"`)
        const committed = Array.isArray(failure.details.deletedIds)
          ? failure.details.deletedIds.filter((value): value is string => typeof value === 'string') : []
        for (const committedId of committed) deleted.add(committedId)
        items.push({ id, ok: false, moved: committed, error: { code: failure.code, message: failure.message } })
      }
    }
    return { items, moved: [...deleted], failed: items.filter(item => !item.ok).map(item => item.id) }
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
    if (this.permanentDelete !== 'confirm') {
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

  /** Read the root record from persistence metadata, without reading the log. */
  private async readRootRecord(sessionId: string): Promise<SessionRecordLike & { formatStatus?: 'current' | 'migration-required' }> {
    const stored = await this.statOrNotFound(sessionId)
    return {
      header: stored.header,
      live: this.isLive(sessionId),
      persisted: true,
      ...(stored.formatStatus === undefined ? {} : { formatStatus: stored.formatStatus }),
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

  /** Wait for the owning DSH component to release a loaded Session or Agent. */
  private async waitForRelease(sessionId: string): Promise<void> {
    const deadline = Date.now() + this.liveSettleTimeoutMs
    while (this.isLive(sessionId)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      // Do not archive, stop, or dispose someone else's live Agent. Those
      // operations do not release its writer and can discard ongoing work.
      await sleep(Math.min(100, remaining))
    }
    const session = this.sessions?.get(sessionId)
    const agent = this.agents?.get(sessionId) as LiveAgentLike | undefined
    if (session === undefined && agent === undefined) return
    if (agent?.status === 'running') {
      throw new ButlerError('session-running', `session "${sessionId}" is still running; stop its activity before retrying`, {
        details: { sessionId },
      })
    }
    throw new ButlerError(
      'session-in-use',
      `session "${sessionId}" remains loaded in this DSH process; release it before retrying`,
      { details: { sessionId } },
    )
  }

  /** Take and release the cross-process write lease once, as a writer probe. */
  private async probeLease(sessionId: string): Promise<void> {
    let handle
    try {
      handle = await this.options.persistence.open(sessionId, 'write')
    } catch (error) {
      if (error !== null && typeof error === 'object'
        && (error as { name?: unknown }).name === 'SessionAlreadyOwnedError') {
        throw new ButlerError('session-locked', `session "${sessionId}" is held by another writer`, {
          details: { sessionId },
          cause: error,
        })
      }
      throw asButlerError(error, 'internal', `cannot inspect write ownership for "${sessionId}"`)
    }
    try {
      await handle.close()
    } catch (error) {
      throw asButlerError(error, 'internal', `cannot release the write probe for "${sessionId}"`)
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
