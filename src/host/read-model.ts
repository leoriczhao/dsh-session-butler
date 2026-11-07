/**
 * Pure projections from DSH session logs and lineage traces into the plugin's
 * read model.
 *
 * The plugin deliberately derives turns, tool counts, token usage, and the
 * latest title from the cloned raw event log instead of reading projection
 * registry keys: the projection key set differs between compositions (the
 * Web app adds `sessionStats` and `session-turn-outline`; base/headless does
 * not), while the event vocabulary below is part of the session format in
 * every published rc. Missing or unfamiliar events are skipped; the fold never
 * invents a figure it did not observe.
 *
 * @module dsh-session-butler/host/read-model
 */

import type {
  SessionEventLike,
  SessionHeaderLike,
  SessionLineageNodeLike,
  SessionLineageTraceLike,
} from './ports.js'

/** Cumulative provider token usage observed on assistant messages. */
export interface TokenTotals {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Log-derived session figures; absent fields were not observed. */
export interface SessionEventStats {
  readonly turns: number
  readonly steps: number
  readonly userMessages: number
  readonly assistantMessages: number
  readonly toolCalls: number
  readonly toolResults: number
  readonly lastActivityAt?: number
  readonly tokens?: TokenTotals
  readonly title?: string
}

/** One lineage row (the target's ancestors and descendant-tree nodes). */
export interface LineageEntry {
  readonly id: string
  readonly cwd?: string
  readonly createdAt?: number
  readonly origin?: 'subagent'
  readonly agentPreset?: string
}

/** One recursive lineage descendant node. */
export interface LineageNode extends LineageEntry {
  readonly descendants: readonly LineageNode[]
}

/** Known ancestry and descendants for one session. */
export interface SessionLineageView {
  readonly complete: boolean
  readonly missingParentId?: string
  readonly ancestors: readonly LineageEntry[]
  readonly descendants: readonly LineageNode[]
}

/** One session row in the Host read model (tools and future bridges). */
export interface SessionListEntry {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly title?: string
  readonly archived: boolean
  readonly pinned: boolean
  readonly subagent: boolean
  readonly parentSession?: string
  readonly agentPreset?: string
  readonly formatStatus?: 'current' | 'migration-required'
  /** A live Session or Agent belongs to this process. */
  readonly live: boolean
}

/** Result of one read-model listing. */
export interface SessionListResult {
  readonly sessions: readonly SessionListEntry[]
  /** Matching sessions before the limit was applied. */
  readonly total: number
  readonly truncated: boolean
}

/** Filters accepted by the listing (all optional; defaults documented). */
export interface SessionListFilters {
  /** Case-insensitive substring of the session id or working directory. */
  readonly query?: string
  /** Case-insensitive working-directory prefix. */
  readonly cwd?: string
  /** Include archived sessions (default false). */
  readonly includeArchived?: boolean
  /** Keep only archived sessions (settings → Archived chats). */
  readonly archivedOnly?: boolean
  /** Include subagent sessions (default true). */
  readonly includeSubagents?: boolean
  /** Rows to return, 1-100 (default 25). */
  readonly limit?: number
}

/** Read one property of an unknown value as a record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read one finite number property, or undefined. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read one non-empty string property, or undefined. */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Project one header into the lineage row shape. */
export function headerEntry(header: SessionHeaderLike): LineageEntry {
  return {
    id: header.id,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.createdAt === undefined ? {} : { createdAt: header.createdAt }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

/** Project one descendant node recursively, preserving the tree shape. */
function descendantNode(node: SessionLineageNodeLike): LineageNode {
  return {
    ...headerEntry(node.session.header),
    descendants: node.descendants.map(descendantNode),
  }
}

/**
 * Project a `traceSession` result into the read model.
 * @param trace - known ancestry and descendants.
 * @returns lineage row lists plus whether the parent chain is complete.
 */
export function lineageView(trace: SessionLineageTraceLike): SessionLineageView {
  const complete = trace.complete !== false
  const missingParentId = (trace as { unresolvedParentId?: unknown }).unresolvedParentId
  return {
    complete,
    ...(complete || typeof missingParentId !== 'string' ? {} : { missingParentId }),
    ancestors: trace.ancestors.map(record => headerEntry(record.header)),
    descendants: trace.descendants.map(descendantNode),
  }
}

/**
 * Fold one raw event log into counts, token usage, and the latest title.
 *
 * Counts describe the observed log, including superseded surface nodes; they
 * are not a render of the current model context. Unknown event types and
 * malformed payloads are skipped.
 * @param events - cloned raw events in ascending seq order.
 * @returns the observed figures; `tokens` is absent when no usage was recorded.
 */
export function summarizeSessionEvents(events: readonly SessionEventLike[]): SessionEventStats {
  let turns = 0
  let steps = 0
  let userMessages = 0
  let assistantMessages = 0
  let toolCalls = 0
  let toolResults = 0
  let lastActivityAt: number | undefined
  let title: string | undefined
  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let sawUsage = false

  for (const event of events) {
    if (typeof event.time === 'number' && Number.isFinite(event.time)) {
      lastActivityAt = lastActivityAt === undefined ? event.time : Math.max(lastActivityAt, event.time)
    }
    const data = asRecord(event.data)
    switch (event.type) {
      case 'turn/end':
        turns += 1
        break
      case 'step/end':
        steps += 1
        break
      case 'user/message':
        userMessages += 1
        break
      case 'tool/call':
        toolCalls += 1
        break
      case 'tool/result':
        toolResults += 1
        break
      case 'assistant/message': {
        assistantMessages += 1
        const usage = asRecord(data?.usage)
        if (usage !== undefined) {
          sawUsage = true
          tokens.inputTokens += asNumber(usage.inputTokens) ?? 0
          tokens.outputTokens += asNumber(usage.outputTokens) ?? 0
          tokens.cacheReadTokens += asNumber(usage.cacheReadTokens) ?? 0
          tokens.cacheWriteTokens += asNumber(usage.cacheWriteTokens) ?? 0
        }
        break
      }
      case 'session/title': {
        const observed = asText(data?.title)
        if (observed !== undefined) title = observed
        break
      }
      default:
        break
    }
  }

  return {
    turns,
    steps,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    ...(sawUsage ? { tokens } : {}),
    ...(title === undefined ? {} : { title }),
  }
}
