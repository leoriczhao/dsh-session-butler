/**
 * Read-only agent tools for session discovery and inspection.
 *
 * Definitions are built structurally, without importing `@deepseek-ai/dsh-tools`:
 * published third-party plugins register plain `ToolDefinition` objects on
 * `ctx.tools`, which is also what keeps this package free of DSH runtime
 * dependencies. The tools only read the Host read model; deletion stays on the
 * explicit Web UI and `/session-butler` surfaces.
 *
 * @module dsh-session-butler/host/tools
 */

import type { ButlerToolDefinition, ButlerToolParameter, ToolsPort } from './ports.js'
import type { SessionDetail } from './service.js'
import type { SessionListEntry, SessionListResult } from './read-model.js'

/** The read-only service surface the tools depend on (test seam). */
export interface ButlerReadModel {
  listSessions(filters: { query?: string; cwd?: string; includeArchived?: boolean; includeSubagents?: boolean; limit?: number }): Promise<SessionListResult>
  detail(sessionId: string): Promise<SessionDetail>
}

/** Coerce a tool argument object without trusting its shape. */
function argsRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Optional string argument. */
function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Optional boolean argument. */
function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name]
  return typeof value === 'boolean' ? value : undefined
}

/** Optional page size argument. */
function optionalLimit(args: Record<string, unknown>): number | undefined {
  const value = args.limit
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(1, Math.trunc(value)))
}

/** Human-readable age of one epoch-ms timestamp. */
function relativeAge(createdAt: number, now: number): string {
  const delta = Math.max(0, now - createdAt)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Render one session row for the tool result. */
function renderRow(entry: SessionListEntry, now: number): string {
  const flags = [
    entry.live ? 'live' : '',
    entry.archived ? 'archived' : '',
    entry.pinned ? 'pinned' : '',
    entry.subagent ? 'subagent' : '',
    entry.formatStatus === 'migration-required' ? 'migration-required' : '',
  ].filter(flag => flag.length > 0)
  const title = entry.title ?? '(untitled)'
  const cwd = entry.cwd ?? '(no cwd)'
  return `${entry.id}  ${title}  ${cwd}  ${relativeAge(entry.createdAt, now)}${flags.length === 0 ? '' : `  [${flags.join(', ')}]`}`
}

/** Flatten a descendant tree into bounded depth rows for the detail tool. */
function flattenDescendants(
  nodes: readonly SessionDetail['lineage']['descendants'][number][],
  parent: string,
  depth: number,
  output: Array<{ id: string; parent: string; depth: number; origin?: 'subagent'; agentPreset?: string; cwd?: string }>,
): void {
  for (const node of nodes) {
    output.push({
      id: node.id,
      parent,
      depth,
      ...(node.origin === undefined ? {} : { origin: node.origin }),
      ...(node.agentPreset === undefined ? {} : { agentPreset: node.agentPreset }),
      ...(node.cwd === undefined ? {} : { cwd: node.cwd }),
    })
    flattenDescendants(node.descendants, node.id, depth + 1, output)
  }
}

/** Build the `session_butler_list` definition. */
export function createListTool(read: ButlerReadModel): ButlerToolDefinition {
  const parameters: Record<string, ButlerToolParameter> = {
    query: {
      type: 'string',
      description: 'Case-insensitive substring of the session id or working directory.',
    },
    cwd: {
      type: 'string',
      description: 'Only sessions whose working directory starts with this path prefix.',
    },
    includeArchived: {
      type: 'boolean',
      description: 'Include archived sessions; default false.',
    },
    includeSubagents: {
      type: 'boolean',
      description: 'Include subagent sessions; default true.',
    },
    limit: {
      type: 'number',
      description: 'Rows to return, 1-100; default 25.',
    },
  }
  return {
    name: 'session_butler_list',
    description:
      'List DSH sessions newest first with id, title, working directory, age, and archived/subagent/live flags. '
      + 'Read-only. Use session_butler_detail with an exact id for counts, token usage, size, and lineage; '
      + 'this tool cannot delete or modify sessions.',
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'truncated', 'sessions'],
        properties: {
          total: { type: 'number' },
          truncated: { type: 'boolean' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'createdAt', 'archived', 'pinned', 'subagent', 'live'],
              properties: {
                id: { type: 'string' },
                createdAt: { type: 'number' },
                cwd: { type: 'string' },
                title: { type: 'string' },
                archived: { type: 'boolean' },
                pinned: { type: 'boolean' },
                subagent: { type: 'boolean' },
                parentSession: { type: 'string' },
                agentPreset: { type: 'string' },
                formatStatus: { type: 'string', enum: ['current', 'migration-required'] },
                live: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const result = value as SessionListResult
        const request = argsRecord(args)
        const limit = optionalLimit(request)
        const lines: string[] = []
        if (result.sessions.length === 0) {
          lines.push('(no sessions)')
        } else {
          const now = Date.now()
          for (const entry of result.sessions) lines.push(renderRow(entry, now))
          if (result.truncated) {
            lines.push(`(showing ${result.sessions.length} of ${result.total}${limit === undefined ? '' : `; limit ${limit}`})`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const request = argsRecord(args)
      const query = optionalString(request, 'query')
      const cwd = optionalString(request, 'cwd')
      const includeArchived = optionalBoolean(request, 'includeArchived')
      const includeSubagents = optionalBoolean(request, 'includeSubagents')
      const limit = optionalLimit(request)
      const filters: {
        query?: string
        cwd?: string
        includeArchived?: boolean
        includeSubagents?: boolean
        limit?: number
      } = {}
      if (query !== undefined) filters.query = query
      if (cwd !== undefined) filters.cwd = cwd
      if (includeArchived !== undefined) filters.includeArchived = includeArchived
      if (includeSubagents !== undefined) filters.includeSubagents = includeSubagents
      if (limit !== undefined) filters.limit = limit
      return read.listSessions(filters)
    },
  }
}

/** Build the `session_butler_detail` definition. */
export function createDetailTool(read: ButlerReadModel): ButlerToolDefinition {
  const parameters: Record<string, ButlerToolParameter> = {
    sessionId: {
      type: 'string',
      required: true,
      description: 'Exact session id (session_butler_list returns ids).',
    },
  }
  return {
    name: 'session_butler_detail',
    description:
      'Inspect one DSH session by exact id: title, working directory, preset, turn/step/message/tool counts, '
      + 'cumulative token usage, log size, and subagent lineage. Read-only; works for cold and live sessions, '
      + 'and reports partial enrichment for sessions awaiting migration.',
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'header', 'live', 'descendantIds', 'enrichment', 'lineage'],
        properties: {
          id: { type: 'string' },
          header: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: {
              id: { type: 'string' },
              cwd: { type: 'string' },
              createdAt: { type: 'number' },
              parentSession: { type: 'string' },
              origin: { type: 'string', enum: ['subagent'] },
              isSeeded: { type: 'boolean' },
              delegationDepth: { type: 'number' },
              agentPreset: { type: 'string' },
            },
          },
          formatStatus: { type: 'string', enum: ['current', 'migration-required'] },
          live: { type: 'boolean' },
          descendantIds: { type: 'array', items: { type: 'string' } },
          enrichment: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: {
              status: { type: 'string', enum: ['complete', 'partial'] },
              reason: { type: 'string', enum: ['migration-required', 'read-failed'] },
            },
          },
          stats: {
            type: 'object',
            additionalProperties: false,
            properties: {
              eventCount: { type: 'number' },
              sizeBytes: { type: 'number' },
              inheritedEventCount: { type: 'number' },
              turns: { type: 'number' },
              steps: { type: 'number' },
              userMessages: { type: 'number' },
              assistantMessages: { type: 'number' },
              toolCalls: { type: 'number' },
              toolResults: { type: 'number' },
              lastActivityAt: { type: 'number' },
              title: { type: 'string' },
              tokens: {
                type: 'object',
                additionalProperties: false,
                required: ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'],
                properties: {
                  inputTokens: { type: 'number' },
                  outputTokens: { type: 'number' },
                  cacheReadTokens: { type: 'number' },
                  cacheWriteTokens: { type: 'number' },
                },
              },
            },
          },
          lineage: {
            type: 'object',
            additionalProperties: false,
            required: ['complete', 'ancestors', 'descendants'],
            properties: {
              complete: { type: 'boolean' },
              missingParentId: { type: 'string' },
              ancestors: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id'],
                  properties: {
                    id: { type: 'string' },
                    cwd: { type: 'string' },
                    agentPreset: { type: 'string' },
                  },
                },
              },
              descendants: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'parent', 'depth'],
                  properties: {
                    id: { type: 'string' },
                    parent: { type: 'string' },
                    depth: { type: 'number' },
                    origin: { type: 'string', enum: ['subagent'] },
                    agentPreset: { type: 'string' },
                    cwd: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const detail = value as ReturnType<typeof toDetailWire>
        const lines: string[] = []
        const title = detail.stats?.title
        lines.push(`${detail.id}${title === undefined ? '' : `  ${title}`}`)
        const header = detail.header
        const facts = [
          header.cwd === undefined ? undefined : `cwd=${header.cwd}`,
          header.createdAt === undefined ? undefined : `created=${new Date(header.createdAt).toISOString()}`,
          header.agentPreset === undefined ? undefined : `preset=${header.agentPreset}`,
          header.origin === undefined ? undefined : 'subagent',
          detail.formatStatus === undefined ? undefined : `format=${detail.formatStatus}`,
          detail.live ? 'live' : undefined,
        ].filter((fact): fact is string => fact !== undefined)
        if (facts.length > 0) lines.push(facts.join('  '))
        const stats = detail.stats
        if (stats !== undefined) {
          const counts = [
            stats.turns === undefined ? undefined : `turns=${stats.turns}`,
            stats.steps === undefined ? undefined : `steps=${stats.steps}`,
            stats.userMessages === undefined ? undefined : `user=${stats.userMessages}`,
            stats.assistantMessages === undefined ? undefined : `assistant=${stats.assistantMessages}`,
            stats.toolCalls === undefined ? undefined : `toolCalls=${stats.toolCalls}`,
            stats.toolResults === undefined ? undefined : `toolResults=${stats.toolResults}`,
          ].filter((fact): fact is string => fact !== undefined)
          if (counts.length > 0) lines.push(counts.join('  '))
          if (stats.tokens !== undefined) {
            const tokens = stats.tokens
            lines.push(`tokens: input=${tokens.inputTokens} output=${tokens.outputTokens} cacheRead=${tokens.cacheReadTokens} cacheWrite=${tokens.cacheWriteTokens}`)
          }
          const size = [
            stats.sizeBytes === undefined ? undefined : `size=${formatBytes(stats.sizeBytes)}`,
            stats.eventCount === undefined ? undefined : `events=${stats.eventCount}`,
          ].filter((fact): fact is string => fact !== undefined)
          if (size.length > 0) lines.push(size.join('  '))
        }
        if (detail.enrichment.status === 'partial') {
          lines.push(`enrichment: partial${detail.enrichment.reason === undefined ? '' : ` (${detail.enrichment.reason})`}`)
        }
        const ancestry = [detail.id, ...detail.lineage.ancestors.map(entry => entry.id)].reverse()
        if (detail.lineage.ancestors.length > 0) {
          lines.push(`lineage: ${ancestry.join(' -> ')}${detail.lineage.complete ? '' : ` (missing ${detail.lineage.missingParentId ?? 'parent'})`}`)
        }
        if (detail.lineage.descendants.length > 0) {
          const shown = detail.lineage.descendants.slice(0, 10).map(node => `${'  '.repeat(node.depth)}${node.id}${node.origin === 'subagent' ? ' [subagent]' : ''}`)
          lines.push('descendants:')
          lines.push(...shown)
          if (detail.lineage.descendants.length > shown.length) {
            lines.push(`  (+${detail.lineage.descendants.length - shown.length} more)`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const request = argsRecord(args)
      const sessionId = optionalString(request, 'sessionId')
      if (sessionId === undefined) throw new Error('sessionId is required (exact id from session_butler_list)')
      const detail = await read.detail(sessionId)
      return toDetailWire(detail)
    },
  }
}

/** Format a byte count for one result line. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Project the service detail into the stable tool wire shape (flattened lineage). */
function toDetailWire(detail: SessionDetail): {
  id: string
  header: SessionDetail['headerSnapshot']
  formatStatus?: SessionDetail['formatStatus']
  live: boolean
  descendantIds: readonly string[]
  enrichment: SessionDetail['enrichment']
  stats?: SessionDetail['stats']
  lineage: {
    complete: boolean
    missingParentId?: string
    ancestors: readonly { id: string; cwd?: string; agentPreset?: string }[]
    descendants: readonly { id: string; parent: string; depth: number; origin?: 'subagent'; agentPreset?: string; cwd?: string }[]
  }
} {
  const descendants: Array<{ id: string; parent: string; depth: number; origin?: 'subagent'; agentPreset?: string; cwd?: string }> = []
  flattenDescendants(detail.lineage.descendants, detail.id, 1, descendants)
  return {
    id: detail.id,
    header: detail.headerSnapshot,
    ...(detail.formatStatus === undefined ? {} : { formatStatus: detail.formatStatus }),
    live: detail.live,
    descendantIds: detail.descendantIds,
    enrichment: detail.enrichment,
    ...(detail.stats === undefined ? {} : { stats: detail.stats }),
    lineage: {
      complete: detail.lineage.complete,
      ...(detail.lineage.missingParentId === undefined ? {} : { missingParentId: detail.lineage.missingParentId }),
      ancestors: detail.lineage.ancestors.map(entry => ({
        id: entry.id,
        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
        ...(entry.agentPreset === undefined ? {} : { agentPreset: entry.agentPreset }),
      })),
      descendants,
    },
  }
}

/**
 * Register the read-only tools.
 * @param tools - Host tool registry.
 * @param read - Host read model (the service in production, a fake in tests).
 * @returns one disposer for both registrations.
 */
export function registerButlerTools(tools: ToolsPort, read: ButlerReadModel): () => void {
  const disposers = [tools.register(createListTool(read)), tools.register(createDetailTool(read))]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Registration disposal is best-effort and must not mask the other one.
      }
    }
  }
}
