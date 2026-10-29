/**
 * Threadloom's Web management page (M2).
 *
 * Rendered in the keyed `main` slot. Sessions come from the Host-backed Client
 * stores (`useSessions` / `useWorkspaces`); trash operations go through the
 * same-origin management bridge. The page only composes audited surfaces — it
 * never imports Harness Client packages or touches the DOM globally.
 *
 * @module dsh-session-butler/client/page
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'

import { BridgeError } from './bridge.js'
import type {
  BatchResultLike,
  BridgeStatus,
  LineageNodeLike,
  SessionButlerPageProps,
  SessionDetailLike,
  SessionStatsLike,
  SessionSummaryLike,
  TrashEntryLike,
  WorkspaceViewLike,
} from './contract.js'
import { consumeThreadloomRequest, subscribeThreadloomRequests } from './navigation.js'

/** Host-enforced ceiling for one batch request. */
const MAX_BATCH_SIZE = 50

/** One destructive-action dialog. */
type Dialog =
  | { readonly kind: 'trash'; readonly row: SessionSummaryLike; readonly detail: SessionDetailLike; readonly cascade: boolean }
  | { readonly kind: 'batch-trash'; readonly ids: readonly string[]; readonly descendants: number; readonly cascade: boolean }
  | { readonly kind: 'detail'; readonly detail: SessionDetailLike }
  | { readonly kind: 'purge'; readonly entry: TrashEntryLike }

/** Human-readable byte count. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Depth-first flattening of lineage nodes, bounded by the dialog. */
function flattenLineage(nodes: readonly LineageNodeLike[], depth = 1): Array<{ node: LineageNodeLike; depth: number }> {
  const rows: Array<{ node: LineageNodeLike; depth: number }> = []
  for (const node of nodes) {
    rows.push({ node, depth })
    rows.push(...flattenLineage(node.descendants, depth + 1))
  }
  return rows
}

/** One `label: value` row inside the detail dialog. */
function DetailRow({ label, children }: { readonly label: string; readonly children: React.ReactNode }): ReactElement {
  return (
    <div className="sb-detail-row">
      <span className="sb-detail-label">{label}</span>
      <span className="sb-detail-value">{children}</span>
    </div>
  )
}

/** Detail dialog body: header identity, folded figures, tokens, size, and lineage. */
export function SessionDetailView({ detail, t }: { readonly detail: SessionDetailLike; readonly t: SessionButlerPageProps['t'] }): ReactElement {
  const header = detail.headerSnapshot
  const stats: SessionStatsLike | undefined = detail.stats
  const facts = [
    detail.live ? t('detail.live') : '',
    detail.formatStatus === undefined ? '' : t('detail.format', { status: detail.formatStatus }),
  ].filter(fact => fact.length > 0)
  const descendants = flattenLineage(detail.lineage.descendants)
  return (
    <>
      <div className="sb-detail-grid">
        <DetailRow label={t('detail.idLabel')}><span className="sb-mono">{detail.id}</span></DetailRow>
        {header.createdAt !== undefined && <DetailRow label={t('detail.createdLabel')}>{formatTime(header.createdAt)}</DetailRow>}
        {header.cwd !== undefined && <DetailRow label={t('detail.cwdLabel')}><span className="sb-mono">{header.cwd}</span></DetailRow>}
        {header.agentPreset !== undefined && <DetailRow label={t('detail.presetLabel')}>{header.agentPreset}</DetailRow>}
        {facts.length > 0 && <DetailRow label={t('detail.stateLabel')}>{facts.join(' · ')}</DetailRow>}
      </div>
      {detail.enrichment.status === 'partial' && (
        <p className="sb-hint">{t('detail.enrichment.partial', { reason: detail.enrichment.reason ?? 'unknown' })}</p>
      )}
      {stats === undefined
        ? <p className="sb-hint">{t('detail.noStats')}</p>
        : (
          <div className="sb-detail-grid">
            <DetailRow label={t('detail.metricsLabel')}>
              {t('detail.metrics', {
                turns: stats.turns ?? 0,
                steps: stats.steps ?? 0,
                user: stats.userMessages ?? 0,
                assistant: stats.assistantMessages ?? 0,
                calls: stats.toolCalls ?? 0,
                results: stats.toolResults ?? 0,
              })}
            </DetailRow>
            {stats.tokens !== undefined && (
              <DetailRow label={t('detail.tokensLabel')}>
                {t('detail.tokens', {
                  input: stats.tokens.inputTokens,
                  output: stats.tokens.outputTokens,
                  read: stats.tokens.cacheReadTokens,
                  write: stats.tokens.cacheWriteTokens,
                })}
              </DetailRow>
            )}
            {(stats.sizeBytes !== undefined || stats.eventCount !== undefined) && (
              <DetailRow label={t('detail.logLabel')}>
                {t('detail.size', { size: formatBytes(stats.sizeBytes ?? 0), events: stats.eventCount ?? 0 })}
              </DetailRow>
            )}
          </div>
        )}
      {(!detail.lineage.complete || detail.lineage.ancestors.length > 0 || descendants.length > 0) && (
        <div className="sb-detail-grid">
          {!detail.lineage.complete && (
            <div className="sb-hint">{t('detail.parentMissing', { id: detail.lineage.missingParentId ?? '?' })}</div>
          )}
          {detail.lineage.ancestors.length > 0 && <div className="sb-detail-label">{t('detail.lineage')}</div>}
          {detail.lineage.ancestors.map(entry => (
            <div key={`ancestor-${entry.id}`} className="sb-lineage">↑ <span className="sb-mono">{entry.id}</span>{entry.cwd === undefined ? '' : ` · ${tailPath(entry.cwd)}`}</div>
          ))}
          {descendants.length > 0 && (
            <>
              <div className="sb-detail-label">{t('detail.descendants', { count: descendants.length })}</div>
              {descendants.map(row => (
                <div key={`descendant-${row.node.id}`} className="sb-lineage">
                  {'  '.repeat(row.depth)}↳ <span className="sb-mono">{row.node.id}</span>
                  {row.node.agentPreset === undefined ? '' : ` · ${row.node.agentPreset}`}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </>
  )
}

/** Format one Unix epoch ms as a local date-time. */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** Last path segment for compact rows. */
function tailPath(value: string): string {
  const parts = value.split(/[\\/]/).filter(part => part.length > 0)
  return parts.at(-1) ?? value
}

/** Page-local styles; only theme tokens (with fallbacks) keep the host look. */
const CSS = `
.sb-page { height: 100%; display: flex; flex-direction: column; gap: 14px; padding: 22px clamp(20px, 4vw, 44px) 30px; overflow-y: auto; }
.sb-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.sb-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 28px; }
.sb-subtitle { margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary, #475467); }
.sb-actions { display: flex; align-items: center; gap: 8px; }
.sb-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2, #d0d5dd); background: transparent; color: inherit; border-radius: var(--dsw-radius-sm, 6px); padding: 6px 12px; font-size: 13px; line-height: 18px; cursor: pointer; }
.sb-btn:hover { border-color: var(--dsw-alias-border-l4, #98a2b3); }
.sb-btn:disabled { opacity: .5; cursor: not-allowed; }
.sb-btn-danger { border-color: var(--dsw-alias-state-error-primary, #d92d20); color: var(--dsw-alias-state-error-primary, #d92d20); }
.sb-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--dsw-alias-border-l2, #eaecf0); padding-bottom: 8px; }
.sb-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary, #667085); padding: 6px 10px; font-size: 13px; border-radius: var(--dsw-radius-sm, 6px); cursor: pointer; }
.sb-tab[data-active="true"] { color: inherit; background: var(--dsw-alias-bg-l2, rgba(127,127,127,.10)); font-weight: 600; }
.sb-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.sb-input, .sb-select { height: 30px; border: 1px solid var(--dsw-alias-border-l2, #d0d5dd); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: inherit; padding: 0 10px; font-size: 13px; }
.sb-input { min-width: 240px; flex: 1 1 240px; }
.sb-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-tertiary, #667085); }
.sb-count { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-tertiary, #667085); }
.sb-list { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2, #eaecf0); border-radius: var(--dsw-radius-lg, 10px); overflow: hidden; }
.sb-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1, #f2f4f7); }
.sb-row:first-child { border-top: 0; }
.sb-row-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.sb-row-title { font-size: 13px; font-weight: 600; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-row-meta { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #667085); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-row-actions { display: flex; gap: 6px; flex-shrink: 0; }
.sb-badges { display: flex; flex-wrap: wrap; gap: 4px; }
.sb-badge { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #eaecf0); color: var(--dsw-alias-label-tertiary, #667085); }
.sb-badge-warn { border-color: var(--dsw-alias-state-warning-primary, #b54708); color: var(--dsw-alias-state-warning-primary, #b54708); }
.sb-badge-error { border-color: var(--dsw-alias-state-error-primary, #d92d20); color: var(--dsw-alias-state-error-primary, #d92d20); }
.sb-empty { padding: 28px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary, #667085); }
.sb-message { font-size: 12px; line-height: 18px; min-height: 18px; }
.sb-message[data-kind="error"] { color: var(--dsw-alias-state-error-primary, #d92d20); }
.sb-message[data-kind="info"] { color: var(--dsw-alias-label-tertiary, #667085); }
.sb-footer { margin-top: auto; font-size: 12px; color: var(--dsw-alias-label-tertiary, #667085); }
.sb-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(15, 23, 42, .38); display: flex; align-items: center; justify-content: center; padding: 24px; }
.sb-dialog { width: min(440px, 100%); background: var(--dsw-alias-bg-l1, #ffffff); color: var(--dsw-alias-label-primary, #101828); border: 1px solid var(--dsw-alias-border-l2, #eaecf0); border-radius: var(--dsw-radius-lg, 10px); padding: 20px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 18px 48px rgba(15, 23, 42, .18); }
.sb-dialog-title { margin: 0; font-size: 15px; font-weight: 600; }
.sb-dialog-body { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary, #475467); }
.sb-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.sb-check { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.sb-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #667085); }
.sb-pick { flex-shrink: 0; }
.sb-batchbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 10px; border: 1px dashed var(--dsw-alias-border-l2, #d0d5dd); border-radius: var(--dsw-radius-sm, 6px); font-size: 13px; }
.sb-batchbar .sb-count { margin-left: 0; }
.sb-dialog-wide { width: min(620px, 100%); max-height: min(78vh, 720px); overflow-y: auto; }
.sb-detail-grid { display: flex; flex-direction: column; gap: 4px; font-size: 13px; line-height: 20px; }
.sb-detail-row { display: flex; gap: 10px; }
.sb-detail-label { flex-shrink: 0; min-width: 96px; color: var(--dsw-alias-label-secondary, #475467); }
.sb-detail-value { word-break: break-word; }
.sb-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, monospace); font-size: 12px; }
.sb-lineage { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #667085); white-space: pre-wrap; }
`

/** One session row. */
function SessionRow({ row, workspace, archived, pinned, selected, busy, t, onSelect, onOpen, onDetails, onTrash }: {
  row: SessionSummaryLike
  workspace: WorkspaceViewLike | undefined
  archived: boolean
  pinned: boolean
  selected: boolean
  busy: boolean
  t: SessionButlerPageProps['t']
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onDetails: (row: SessionSummaryLike) => void
  onTrash: (row: SessionSummaryLike) => void
}): ReactElement {
  const badges: ReactElement[] = []
  if (row.running) badges.push(<span key="running" className="sb-badge">{t('badge.running')}</span>)
  if (row.blank) badges.push(<span key="blank" className="sb-badge">{t('badge.blank')}</span>)
  if (row.origin === 'subagent') badges.push(<span key="subagent" className="sb-badge">{t('badge.subagent')}</span>)
  if (archived) badges.push(<span key="archived" className="sb-badge">{t('badge.archived')}</span>)
  if (pinned) badges.push(<span key="pinned" className="sb-badge">{t('badge.pinned')}</span>)
  if (row.formatStatus === 'migration-required') {
    badges.push(<span key="migration" className="sb-badge sb-badge-warn">{t('badge.migration')}</span>)
  }
  const metaParts = [
    row.cwd === undefined ? undefined : tailPath(row.cwd),
    workspace?.title,
    t('row.updated', { time: formatTime(row.updatedAt) }),
  ].filter((part): part is string => typeof part === 'string' && part.length > 0)
  const meta = [...new Set(metaParts)].join(' · ')
  return (
    <div className="sb-row">
      <input
        type="checkbox"
        className="sb-pick"
        checked={selected}
        aria-label={t('action.selectRow')}
        onChange={() => onSelect(row.id)}
      />
      <div className="sb-row-main">
        <div className="sb-row-title" title={row.displayTitle}>{row.displayTitle}</div>
        <div className="sb-row-meta" title={row.cwd ?? row.id}>{meta}</div>
        {badges.length > 0 && <div className="sb-badges">{badges}</div>}
      </div>
      <div className="sb-row-actions">
        <button type="button" className="sb-btn" onClick={() => onDetails(row)}>{t('action.details')}</button>
        <button type="button" className="sb-btn" onClick={() => onOpen(row.id)}>{t('action.open')}</button>
        <button type="button" className="sb-btn sb-btn-danger" disabled={busy} onClick={() => onTrash(row)}>{t('action.trash')}</button>
      </div>
    </div>
  )
}

/** One trash row. */
function TrashRow({ entry, canPurge, selected, busy, t, onSelect, onRestore, onPurge }: {
  entry: TrashEntryLike
  canPurge: boolean
  selected: boolean
  busy: boolean
  t: SessionButlerPageProps['t']
  onSelect: (id: string) => void
  onRestore: (entry: TrashEntryLike) => void
  onPurge: (entry: TrashEntryLike) => void
}): ReactElement {
  const badges: ReactElement[] = []
  if (entry.expired) badges.push(<span key="expired" className="sb-badge sb-badge-warn">{t('badge.expired')}</span>)
  if (entry.cascadeOf !== undefined) badges.push(<span key="cascadeOf" className="sb-badge">{t('badge.cascadeOf', { id: entry.cascadeOf })}</span>)
  if (entry.descendants.length > 0) badges.push(<span key="cascade" className="sb-badge">{t('badge.cascade', { count: entry.descendants.length })}</span>)
  return (
    <div className="sb-row">
      <input
        type="checkbox"
        className="sb-pick"
        checked={selected}
        aria-label={t('action.selectRow')}
        onChange={() => onSelect(entry.id)}
      />
      <div className="sb-row-main">
        <div className="sb-row-title" title={entry.id}>{entry.id}</div>
        <div className="sb-row-meta" title={entry.originalPath}>
          {t('row.deleted', { time: formatTime(entry.deletedAt) })} · {t('row.from', { path: tailPath(entry.originalPath) })}
        </div>
        {badges.length > 0 && <div className="sb-badges">{badges}</div>}
      </div>
      <div className="sb-row-actions">
        <button type="button" className="sb-btn" disabled={busy} onClick={() => onRestore(entry)}>{t('action.restore')}</button>
        <button type="button" className="sb-btn sb-btn-danger" disabled={busy || !canPurge} title={canPurge ? undefined : t('footer.permanentDisabled')} onClick={() => onPurge(entry)}>{t('action.purge')}</button>
      </div>
    </div>
  )
}

/** The keyed `main` panel component. */
export function SessionButlerPage(props: SessionButlerPageProps): ReactElement {
  const { t, call } = props
  const sessions = props.useSessions(state => state)
  const workspaces = props.useWorkspaces(state => state)

  const [tab, setTab] = useState<'sessions' | 'trash'>('sessions')
  const [query, setQuery] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState('all')
  const [showArchived, setShowArchived] = useState(false)
  const [showSubagent, setShowSubagent] = useState(false)
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [entries, setEntries] = useState<readonly TrashEntryLike[]>([])
  const [orphans, setOrphans] = useState(0)
  const [busy, setBusy] = useState(false)
  const [loadingTrash, setLoadingTrash] = useState(true)
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [purgeInput, setPurgeInput] = useState('')
  const [selectedSessions, setSelectedSessions] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedTrash, setSelectedTrash] = useState<ReadonlySet<string>>(() => new Set())

  const fail = useCallback((error: unknown): void => {
    if (error instanceof BridgeError) {
      setMessage({ kind: 'error', text: t('status.error', { code: error.code, message: error.message }) })
    } else {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [t])

  const loadTrash = useCallback(async (): Promise<void> => {
    setLoadingTrash(true)
    try {
      const [nextStatus, listing] = await Promise.all([
        call<BridgeStatus>('status'),
        call<{ entries: readonly TrashEntryLike[]; orphans: number }>('list-trash'),
      ])
      setStatus(nextStatus)
      setEntries(listing.entries)
      setOrphans(listing.orphans)
      if (listing.orphans > 0) {
        setMessage({ kind: 'info', text: t('status.orphans', { count: listing.orphans }) })
      }
    } catch (error) {
      fail(error)
    } finally {
      setLoadingTrash(false)
    }
  }, [call, fail, t])

  useEffect(() => { void loadTrash() }, [loadTrash])

  const workspaceBySession = useMemo((): ReadonlyMap<string, WorkspaceViewLike> => {
    const map = new Map<string, WorkspaceViewLike>()
    for (const workspace of workspaces.items) {
      for (const sessionId of workspace.sessionIds) map.set(sessionId, workspace)
    }
    return map
  }, [workspaces.items])
  const archivedSessions = useMemo(() => new Set(workspaces.archivedSessionIds), [workspaces.archivedSessionIds])
  const pinnedOrder = useMemo((): ReadonlyMap<string, number> => {
    const map = new Map<string, number>()
    workspaces.pinnedSessionIds.forEach((id, index) => { map.set(id, index) })
    return map
  }, [workspaces.pinnedSessionIds])

  const visibleSessions = useMemo((): readonly SessionSummaryLike[] => {
    const needle = query.trim().toLowerCase()
    const rows: SessionSummaryLike[] = []
    for (const id of sessions.ids) {
      const row = sessions.byId[id]
      if (row === undefined) continue
      if (!showSubagent && row.origin === 'subagent') continue
      if (!showArchived && archivedSessions.has(row.id)) continue
      if (workspaceFilter !== 'all') {
        const workspace = workspaceBySession.get(row.id)
        if (workspace === undefined || workspace.workspaceId !== workspaceFilter) continue
      }
      if (needle.length > 0) {
        const haystack = [row.displayTitle, row.title ?? '', row.cwd ?? '', row.id].join('\n').toLowerCase()
        if (!haystack.includes(needle)) continue
      }
      rows.push(row)
    }
    rows.sort((left, right) => {
      const leftPin = pinnedOrder.get(left.id)
      const rightPin = pinnedOrder.get(right.id)
      if (leftPin !== undefined || rightPin !== undefined) {
        return (leftPin ?? Number.MAX_SAFE_INTEGER) - (rightPin ?? Number.MAX_SAFE_INTEGER)
      }
      return right.updatedAt - left.updatedAt
    })
    return rows.slice(0, 300)
  }, [sessions, archivedSessions, pinnedOrder, workspaceBySession, workspaceFilter, showArchived, showSubagent, query])

  const refreshAll = useCallback((): void => {
    props.refreshSessions()
    void loadTrash()
  }, [props, loadTrash])

  const requestTrash = useCallback(async (row: SessionSummaryLike): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const detail = await call<SessionDetailLike>('detail', { sessionId: row.id })
      if (detail.formatStatus === 'migration-required') {
        setMessage({ kind: 'error', text: t('dialog.trash.migration') })
        return
      }
      setDialog({ kind: 'trash', row, detail, cascade: status?.cascadeSubagents ?? true })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }, [call, fail, status, t])

  const confirmTrash = useCallback(async (): Promise<void> => {
    if (dialog?.kind !== 'trash') return
    setBusy(true)
    try {
      await call('trash', { sessionId: dialog.row.id, cascade: dialog.cascade })
      setMessage({ kind: 'info', text: t('status.trashed', { id: dialog.row.id }) })
      setDialog(null)
      props.refreshSessions()
      await loadTrash()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }, [call, dialog, fail, loadTrash, props, t])

  const restoreEntry = useCallback(async (entry: TrashEntryLike): Promise<void> => {
    setBusy(true)
    try {
      await call('restore', { sessionId: entry.id })
      setMessage({ kind: 'info', text: t('status.restored', { id: entry.id }) })
      props.refreshSessions()
      await loadTrash()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }, [call, fail, loadTrash, props, t])

  const toggleSelection = useCallback((setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>, id: string): void => {
    setter((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAllSessions = useCallback((ids: readonly string[], checked: boolean): void => {
    setSelectedSessions((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  const toggleAllTrash = useCallback((ids: readonly string[], checked: boolean): void => {
    setSelectedTrash((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  const openDetailsById = useCallback(async (sessionId: string): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const detail = await call<SessionDetailLike>('detail', { sessionId })
      setDialog({ kind: 'detail', detail })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }, [call, fail])

  const openDetails = useCallback(async (row: SessionSummaryLike): Promise<void> => {
    await openDetailsById(row.id)
  }, [openDetailsById])

  // The row "..." menu lives in a different slot than this panel, so it leaves
  // a one-shot request here; apply it on mount and on every new request.
  useEffect(() => {
    const apply = (): void => {
      const request = consumeThreadloomRequest()
      if (request === null) return
      if (request.view === 'trash') {
        setTab('trash')
        return
      }
      setTab('sessions')
      if (request.view === 'detail' && request.sessionId !== undefined) {
        void openDetailsById(request.sessionId)
      }
    }
    apply()
    return subscribeThreadloomRequests(apply)
  }, [openDetailsById])

  const requestBatchTrash = useCallback(async (): Promise<void> => {
    const ids = [...selectedSessions]
    if (ids.length === 0) return
    if (ids.length > MAX_BATCH_SIZE) {
      setMessage({ kind: 'error', text: t('batch.tooMany', { max: MAX_BATCH_SIZE }) })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      // Confirmation needs each header's formatStatus and cascade count. Read
      // details in small groups so a large batch does not open many event logs
      // at once.
      const details: SessionDetailLike[] = []
      for (let offset = 0; offset < ids.length; offset += 4) {
        details.push(...await Promise.all(ids.slice(offset, offset + 4).map(id => call<SessionDetailLike>('detail', { sessionId: id }))))
      }
      if (details.some(detail => detail.formatStatus === 'migration-required')) {
        setMessage({ kind: 'error', text: t('dialog.trash.migration') })
        return
      }
      const descendants = details.reduce((sum, detail) => sum + detail.descendantIds.length, 0)
      setDialog({ kind: 'batch-trash', ids, descendants, cascade: status?.cascadeSubagents ?? true })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }, [call, fail, selectedSessions, status, t])

  const confirmBatchTrash = useCallback(async (): Promise<void> => {
    if (dialog?.kind !== 'batch-trash') return
    setBusy(true)
    try {
      const result = await call<BatchResultLike>('trash-many', { sessionIds: dialog.ids, cascade: dialog.cascade })
      setMessage(result.failed.length === 0
        ? { kind: 'info', text: t('status.batchTrashed', { count: result.moved.length }) }
        : {
            kind: 'error',
            text: `${t('status.batchFailed', {
              failed: result.failed.length,
              total: dialog.ids.length,
              ids: result.failed.join(', '),
            })} ${t('status.batchTrashed', { count: result.moved.length })}`,
          })
      setDialog(null)
      setSelectedSessions(new Set())
      props.refreshSessions()
      await loadTrash()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }, [call, dialog, fail, loadTrash, props, t])

  const restoreSelected = useCallback(async (): Promise<void> => {
    const ids = [...selectedTrash]
    if (ids.length === 0) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await call<BatchResultLike>('restore-many', { sessionIds: ids })
      setMessage(result.failed.length === 0
        ? { kind: 'info', text: t('status.batchRestored', { count: result.moved.length }) }
        : {
            kind: 'error',
            text: `${t('status.batchFailed', {
              failed: result.failed.length,
              total: ids.length,
              ids: result.failed.join(', '),
            })} ${t('status.batchRestored', { count: result.moved.length })}`,
          })
      setSelectedTrash(new Set())
      props.refreshSessions()
      await loadTrash()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }, [call, fail, loadTrash, props, selectedTrash, t])

  const confirmPurge = useCallback(async (): Promise<void> => {
    if (dialog?.kind !== 'purge') return
    setBusy(true)
    try {
      await call('purge', { sessionId: dialog.entry.id, confirmId: purgeInput })
      setMessage({ kind: 'info', text: t('status.purged', { id: dialog.entry.id }) })
      setDialog(null)
      setPurgeInput('')
      await loadTrash()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }, [call, dialog, fail, loadTrash, purgeInput, t])

  const canPurge = status?.permanentDelete === 'confirm'
  const dialogMismatch = dialog?.kind === 'purge' && purgeInput.length > 0 && purgeInput !== dialog.entry.id
  const visibleSessionIds = visibleSessions.map(row => row.id)
  const allSessionsSelected = visibleSessionIds.length > 0 && visibleSessionIds.every(id => selectedSessions.has(id))
  const visibleTrashIds = entries.map(entry => entry.id)
  const allTrashSelected = visibleTrashIds.length > 0 && visibleTrashIds.every(id => selectedTrash.has(id))
  const dialogTitle = dialog === null
    ? ''
    : dialog.kind === 'trash'
      ? t('dialog.trash.title')
      : dialog.kind === 'batch-trash'
        ? t('dialog.batchTrash.title', { count: dialog.ids.length })
        : dialog.kind === 'detail'
          ? t('dialog.detail.title')
          : t('dialog.purge.title')

  return (
    <section className="sb-page" aria-label={t('title')}>
      <style>{CSS}</style>
      <header className="sb-head">
        <div>
          <h1 className="sb-title">{t('title')}</h1>
          <p className="sb-subtitle">{t('subtitle')}</p>
        </div>
        <div className="sb-actions">
          <button type="button" className="sb-btn" disabled={busy || loadingTrash} onClick={refreshAll}>{t('refresh')}</button>
        </div>
      </header>
      <div className="sb-message" data-kind={message?.kind ?? 'info'} role="status" aria-live="polite">{message?.text ?? ''}</div>
      <nav className="sb-tabs">
        <button type="button" className="sb-tab" data-active={tab === 'sessions'} onClick={() => setTab('sessions')}>{t('tabs.sessions')}</button>
        <button type="button" className="sb-tab" data-active={tab === 'trash'} onClick={() => setTab('trash')}>{t('tabs.trash')}</button>
      </nav>

      {tab === 'sessions' ? (
        <>
          <div className="sb-filters">
            <input className="sb-input" value={query} placeholder={t('filter.placeholder')} aria-label={t('filter.placeholder')} onChange={event => setQuery(event.target.value)} />
            <select className="sb-select" value={workspaceFilter} aria-label={t('filter.workspace')} onChange={event => setWorkspaceFilter(event.target.value)}>
              <option value="all">{t('filter.allWorkspaces')}</option>
              {workspaces.items.map(workspace => (
                <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
              ))}
            </select>
            <label className="sb-toggle"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />{t('filter.showArchived')}</label>
            <label className="sb-toggle"><input type="checkbox" checked={showSubagent} onChange={event => setShowSubagent(event.target.checked)} />{t('filter.showSubagent')}</label>
          </div>
          <div className="sb-batchbar">
            <span className="sb-count">{t('count.sessions', { count: visibleSessions.length })}</span>
            <label className="sb-toggle">
              <input
                type="checkbox"
                checked={allSessionsSelected}
                disabled={visibleSessionIds.length === 0}
                onChange={event => toggleAllSessions(visibleSessionIds, event.target.checked)}
              />
              {t('action.selectAll')}
            </label>
            <span className="sb-count">{t('batch.selected', { count: selectedSessions.size })}</span>
            {selectedSessions.size > 0 && (
              <>
                <button type="button" className="sb-btn sb-btn-danger" disabled={busy} onClick={() => { void requestBatchTrash() }}>
                  {t('action.trashSelected', { count: selectedSessions.size })}
                </button>
                <button type="button" className="sb-btn" disabled={busy} onClick={() => setSelectedSessions(new Set())}>
                  {t('action.clearSelection')}
                </button>
              </>
            )}
          </div>
          <div className="sb-list">
            {visibleSessions.length === 0
              ? <div className="sb-empty">{sessions.phase === 'ready' ? t('empty.sessions') : t('loading')}</div>
              : visibleSessions.map(row => (
                <SessionRow
                  key={row.id}
                  row={row}
                  workspace={workspaceBySession.get(row.id)}
                  archived={archivedSessions.has(row.id)}
                  pinned={pinnedOrder.has(row.id)}
                  selected={selectedSessions.has(row.id)}
                  busy={busy}
                  t={t}
                  onSelect={id => toggleSelection(setSelectedSessions, id)}
                  onOpen={props.openSession}
                  onDetails={row => { void openDetails(row) }}
                  onTrash={row => { void requestTrash(row) }}
                />
              ))}
          </div>
        </>
      ) : (
        <>
          <div className="sb-filters">
            <span className="sb-count">{t('count.trash', { count: entries.length })}</span>
          </div>
          <div className="sb-batchbar">
            <label className="sb-toggle">
              <input
                type="checkbox"
                checked={allTrashSelected}
                disabled={visibleTrashIds.length === 0}
                onChange={event => toggleAllTrash(visibleTrashIds, event.target.checked)}
              />
              {t('action.selectAll')}
            </label>
            <span className="sb-count">{t('batch.selected', { count: selectedTrash.size })}</span>
            {selectedTrash.size > 0 && (
              <>
                <button type="button" className="sb-btn" disabled={busy} onClick={() => { void restoreSelected() }}>
                  {t('action.restoreSelected', { count: selectedTrash.size })}
                </button>
                <button type="button" className="sb-btn" disabled={busy} onClick={() => setSelectedTrash(new Set())}>
                  {t('action.clearSelection')}
                </button>
              </>
            )}
          </div>
          <div className="sb-list">
            {loadingTrash
              ? <div className="sb-empty">{t('loading')}</div>
              : entries.length === 0
                ? <div className="sb-empty">{t('empty.trash')}</div>
                : entries.map(entry => (
                  <TrashRow
                    key={entry.id}
                    entry={entry}
                    canPurge={canPurge}
                    selected={selectedTrash.has(entry.id)}
                    busy={busy}
                    t={t}
                    onSelect={id => toggleSelection(setSelectedTrash, id)}
                    onRestore={entry => { void restoreEntry(entry) }}
                    onPurge={entry => { setPurgeInput(''); setDialog({ kind: 'purge', entry }) }}
                  />
                ))}
          </div>
        </>
      )}

      <footer className="sb-footer">
        {status === null ? '' : status.permanentDelete === 'confirm'
          ? t('footer.retention', { days: status.retentionDays })
          : t('footer.permanentDisabled')}
        {status !== null && !status.workspaceAvailable ? ` ${t('dialog.trash.running')}` : ''}
      </footer>

      {dialog !== null && (
        <div className="sb-overlay" role="presentation" onClick={event => { if (event.target === event.currentTarget && !busy) setDialog(null) }}>
          <div
            className={dialog.kind === 'detail' ? 'sb-dialog sb-dialog-wide' : 'sb-dialog'}
            role="dialog"
            aria-modal="true"
            aria-label={dialogTitle}
          >
            <h2 className="sb-dialog-title">{dialogTitle}</h2>
            {dialog.kind === 'trash' ? (
              <>
                <p className="sb-dialog-body">{t('dialog.trash.body', { title: dialog.row.displayTitle })}</p>
                {dialog.row.running && <p className="sb-hint">{t('dialog.trash.running')}</p>}
                {dialog.detail.descendantIds.length > 0 && (
                  <label className="sb-check">
                    <input type="checkbox" checked={dialog.cascade} onChange={event => setDialog({ ...dialog, cascade: event.target.checked })} />
                    {t('dialog.trash.cascade', { count: dialog.detail.descendantIds.length })}
                  </label>
                )}
                <div className="sb-dialog-actions">
                  <button type="button" className="sb-btn" disabled={busy} onClick={() => setDialog(null)}>{t('action.cancel')}</button>
                  <button type="button" className="sb-btn sb-btn-danger" disabled={busy} onClick={() => { void confirmTrash() }}>{t('action.trash')}</button>
                </div>
              </>
            ) : dialog.kind === 'batch-trash' ? (
              <>
                <p className="sb-dialog-body">{t('dialog.batchTrash.body')}</p>
                {dialog.descendants > 0 && (
                  <label className="sb-check">
                    <input type="checkbox" checked={dialog.cascade} onChange={event => setDialog({ ...dialog, cascade: event.target.checked })} />
                    {t('dialog.batchTrash.cascade', { count: dialog.descendants })}
                  </label>
                )}
                <div className="sb-dialog-actions">
                  <button type="button" className="sb-btn" disabled={busy} onClick={() => setDialog(null)}>{t('action.cancel')}</button>
                  <button type="button" className="sb-btn sb-btn-danger" disabled={busy} onClick={() => { void confirmBatchTrash() }}>{t('action.trash')}</button>
                </div>
              </>
            ) : dialog.kind === 'detail' ? (
              <>
                <SessionDetailView detail={dialog.detail} t={t} />
                <div className="sb-dialog-actions">
                  <button type="button" className="sb-btn" onClick={() => setDialog(null)}>{t('action.cancel')}</button>
                </div>
              </>
            ) : (
              <>
                <p className="sb-dialog-body">{t('dialog.purge.body', { id: dialog.entry.id })}</p>
                <input
                  className="sb-input"
                  autoFocus
                  value={purgeInput}
                  placeholder={t('dialog.purge.placeholder')}
                  aria-label={t('dialog.purge.placeholder')}
                  onChange={event => setPurgeInput(event.target.value)}
                />
                {dialogMismatch && <p className="sb-hint">{t('dialog.purge.mismatch')}</p>}
                <div className="sb-dialog-actions">
                  <button type="button" className="sb-btn" disabled={busy} onClick={() => setDialog(null)}>{t('action.cancel')}</button>
                  <button type="button" className="sb-btn sb-btn-danger" disabled={busy || purgeInput !== dialog.entry.id} onClick={() => { void confirmPurge() }}>{t('action.delete')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/** Sidebar entry icon (inherits the host's current color). */
export function SessionButlerIcon({ size = 16 }: { readonly size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="5.2" cy="3.5" r="1.1" fill="currentColor" />
      <circle cx="10.8" cy="8" r="1.1" fill="currentColor" />
      <circle cx="7" cy="12.5" r="1.1" fill="currentColor" />
    </svg>
  )
}
