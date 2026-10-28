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
  BridgeStatus,
  SessionButlerPageProps,
  SessionDetailLike,
  SessionSummaryLike,
  TrashEntryLike,
  WorkspaceViewLike,
} from './contract.js'

/** One destructive-action dialog. */
type Dialog =
  | { readonly kind: 'trash'; readonly row: SessionSummaryLike; readonly detail: SessionDetailLike; readonly cascade: boolean }
  | { readonly kind: 'purge'; readonly entry: TrashEntryLike }

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
.sb-subtitle { margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-dimmed, #667085); }
.sb-actions { display: flex; align-items: center; gap: 8px; }
.sb-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2, #d0d5dd); background: transparent; color: inherit; border-radius: var(--dsw-radius-sm, 6px); padding: 6px 12px; font-size: 13px; line-height: 18px; cursor: pointer; }
.sb-btn:hover { border-color: var(--dsw-alias-border-l4, #98a2b3); }
.sb-btn:disabled { opacity: .5; cursor: not-allowed; }
.sb-btn-danger { border-color: var(--dsw-alias-state-error-primary, #d92d20); color: var(--dsw-alias-state-error-primary, #d92d20); }
.sb-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--dsw-alias-border-l2, #eaecf0); padding-bottom: 8px; }
.sb-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-dimmed, #667085); padding: 6px 10px; font-size: 13px; border-radius: var(--dsw-radius-sm, 6px); cursor: pointer; }
.sb-tab[data-active="true"] { color: inherit; background: var(--dsw-alias-bg-l2, rgba(127,127,127,.10)); font-weight: 600; }
.sb-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.sb-input, .sb-select { height: 30px; border: 1px solid var(--dsw-alias-border-l2, #d0d5dd); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: inherit; padding: 0 10px; font-size: 13px; }
.sb-input { min-width: 240px; flex: 1 1 240px; }
.sb-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-dimmed, #667085); }
.sb-count { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-dimmed, #667085); }
.sb-list { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2, #eaecf0); border-radius: var(--dsw-radius-lg, 10px); overflow: hidden; }
.sb-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1, #f2f4f7); }
.sb-row:first-child { border-top: 0; }
.sb-row-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.sb-row-title { font-size: 13px; font-weight: 600; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-row-meta { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-dimmed, #667085); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-row-actions { display: flex; gap: 6px; flex-shrink: 0; }
.sb-badges { display: flex; flex-wrap: wrap; gap: 4px; }
.sb-badge { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #eaecf0); color: var(--dsw-alias-label-dimmed, #667085); }
.sb-badge-warn { border-color: var(--dsw-alias-state-warning-primary, #b54708); color: var(--dsw-alias-state-warning-primary, #b54708); }
.sb-badge-error { border-color: var(--dsw-alias-state-error-primary, #d92d20); color: var(--dsw-alias-state-error-primary, #d92d20); }
.sb-empty { padding: 28px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-dimmed, #667085); }
.sb-message { font-size: 12px; line-height: 18px; min-height: 18px; }
.sb-message[data-kind="error"] { color: var(--dsw-alias-state-error-primary, #d92d20); }
.sb-message[data-kind="info"] { color: var(--dsw-alias-label-dimmed, #667085); }
.sb-footer { margin-top: auto; font-size: 12px; color: var(--dsw-alias-label-dimmed, #667085); }
.sb-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(15, 23, 42, .38); display: flex; align-items: center; justify-content: center; padding: 24px; }
.sb-dialog { width: min(440px, 100%); background: var(--dsw-alias-bg-l1, #ffffff); color: var(--dsw-alias-label-primary, #101828); border: 1px solid var(--dsw-alias-border-l2, #eaecf0); border-radius: var(--dsw-radius-lg, 10px); padding: 20px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 18px 48px rgba(15, 23, 42, .18); }
.sb-dialog-title { margin: 0; font-size: 15px; font-weight: 600; }
.sb-dialog-body { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-dimmed, #667085); }
.sb-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.sb-check { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.sb-hint { font-size: 12px; color: var(--dsw-alias-label-dimmed, #667085); }
`

/** One session row. */
function SessionRow({ row, workspace, archived, pinned, busy, t, onOpen, onTrash }: {
  row: SessionSummaryLike
  workspace: WorkspaceViewLike | undefined
  archived: boolean
  pinned: boolean
  busy: boolean
  t: SessionButlerPageProps['t']
  onOpen: (id: string) => void
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
      <div className="sb-row-main">
        <div className="sb-row-title" title={row.displayTitle}>{row.displayTitle}</div>
        <div className="sb-row-meta" title={row.cwd ?? row.id}>{meta}</div>
        {badges.length > 0 && <div className="sb-badges">{badges}</div>}
      </div>
      <div className="sb-row-actions">
        <button type="button" className="sb-btn" onClick={() => onOpen(row.id)}>{t('action.open')}</button>
        <button type="button" className="sb-btn sb-btn-danger" disabled={busy} onClick={() => onTrash(row)}>{t('action.trash')}</button>
      </div>
    </div>
  )
}

/** One trash row. */
function TrashRow({ entry, canPurge, busy, t, onRestore, onPurge }: {
  entry: TrashEntryLike
  canPurge: boolean
  busy: boolean
  t: SessionButlerPageProps['t']
  onRestore: (entry: TrashEntryLike) => void
  onPurge: (entry: TrashEntryLike) => void
}): ReactElement {
  const badges: ReactElement[] = []
  if (entry.expired) badges.push(<span key="expired" className="sb-badge sb-badge-warn">{t('badge.expired')}</span>)
  if (entry.cascadeOf !== undefined) badges.push(<span key="cascadeOf" className="sb-badge">{t('badge.cascadeOf', { id: entry.cascadeOf })}</span>)
  if (entry.descendants.length > 0) badges.push(<span key="cascade" className="sb-badge">{t('badge.cascade', { count: entry.descendants.length })}</span>)
  return (
    <div className="sb-row">
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
            <span className="sb-count">{t('count.sessions', { count: visibleSessions.length })}</span>
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
                  busy={busy}
                  t={t}
                  onOpen={props.openSession}
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
                    busy={busy}
                    t={t}
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
          <div className="sb-dialog" role="dialog" aria-modal="true" aria-label={dialog.kind === 'trash' ? t('dialog.trash.title') : t('dialog.purge.title')}>
            <h2 className="sb-dialog-title">{dialog.kind === 'trash' ? t('dialog.trash.title') : t('dialog.purge.title')}</h2>
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
