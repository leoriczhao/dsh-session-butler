/**
 * Settings sections owned by Threadloom (D-029).
 *
 * The Codex desktop reference exposes chat management in Settings, not as a
 * session library page: Archived chats list, search, unarchive/delete/all-delete,
 * plus the plugin's own trash and configuration pages. These components are
 * registered into the DSH settings shell's `settings.section` slot; the shell
 * owns the modal and the nav, so Threadloom renders only each page body.
 *
 * @module dsh-session-butler/client/settings
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'

import { callBridge, deleteErrorKey } from './bridge.js'
import type {
  ClientConfigLike,
  ConfigFormLike,
  ConfigFormSnapshotLike,
  ConfigPathOpLike,
} from './contract.js'

/** Locale translator shape; bound once at registration so slots need no locale prop. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string

/** One archived row projected from the Host read model listing. */
export interface ArchivedSessionRow {
  readonly id: string
  readonly createdAt?: number
  readonly cwd?: string
  readonly title?: string
  readonly archived?: boolean
}

/** Runtime services shared by all three settings pages. */
export interface SectionActions {
  readonly t: Translate
  readonly call: <T>(method: string, payload?: unknown) => Promise<T>
  readonly uiWorkspace?: {
    readonly unarchiveSession?: (sessionId: string) => Promise<void>
  }
  readonly refreshSessions?: () => void
  readonly configForm?: ConfigFormLike<ClientConfigLike>
}

/** Read the inline-menu switch with the pre-D3.0b field as a fallback. */
export function inlineMenuEnabledFromConfig(value: ClientConfigLike | undefined): boolean {
  return value?.inlineMenuEnabled ?? value?.panelEntryEnabled ?? true
}

/** Human-readable message for a bridge or domain failure. */
function messageOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const record = error as { message?: unknown; code?: unknown }
    if (typeof record.message === 'string' && record.message.length > 0) return record.message
    if (typeof record.code === 'string' && record.code.length > 0) return record.code
  }
  return String(error)
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
})

/** Format one epoch millisecond value, or an em dash when absent. */
function formatTime(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
  return TIME_FORMAT.format(new Date(value))
}

/** Keep long ids readable in a list row. */
function shortId(id: string): string {
  return id.length <= 20 ? id : id.slice(0, 8) + '…' + id.slice(-4)
}

/** Subscribe to the full config form snapshot (status, value, revision). */
function useConfigSnapshot(
  form: ConfigFormLike<ClientConfigLike> | undefined,
): ConfigFormSnapshotLike<ClientConfigLike> | undefined {
  const [snapshot, setSnapshot] = useState<ConfigFormSnapshotLike<ClientConfigLike> | undefined>(
    () => form?.getSnapshot(),
  )
  useEffect(() => {
    if (form === undefined) {
      setSnapshot(undefined)
      return
    }
    setSnapshot(form.getSnapshot())
    return form.subscribe(() => { setSnapshot(form.getSnapshot()) })
  }, [form])
  return snapshot
}

/** One pending confirmation owned by a section page. */
interface DialogSpec {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  readonly danger?: boolean
  /** When present the dialog requires the expected id to be typed. */
  readonly input?: { readonly placeholder: string; readonly expected: string }
  readonly confirm: (typed: string) => void
}

/** Modal confirmation used by the archived and trash pages. */
function ConfirmDialog({ spec, onCancel }: {
  readonly spec: DialogSpec
  readonly onCancel: () => void
}): ReactElement {
  const [typed, setTyped] = useState('')
  const matches = spec.input === undefined || typed === spec.input.expected
  return (
    <div className="sb-settings-overlay" role="presentation" onClick={event => {
      if (event.target === event.currentTarget) onCancel()
    }}>
      <section className="sb-settings-dialog" role="dialog" aria-modal="true" aria-label={spec.title}>
        <h3>{spec.title}</h3>
        <p>{spec.body}</p>
        {spec.input === undefined ? null : (
          <input
            className="sb-settings-input"
            autoFocus
            placeholder={spec.input.placeholder}
            value={typed}
            onChange={event => { setTyped(event.target.value) }}
          />
        )}
        <div className="sb-settings-dialog-actions">
          <button type="button" className="sb-settings-button" onClick={onCancel}>取消</button>
          <button
            type="button"
            className={spec.danger === true ? 'sb-settings-button sb-settings-danger' : 'sb-settings-button sb-settings-primary'}
            disabled={!matches}
            onClick={() => { if (matches) spec.confirm(typed) }}
          >
            {spec.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}

/** Status line shared by the pages. */
function Notice({ text, error }: { readonly text: string | null; readonly error?: boolean }): ReactElement | null {
  if (text === null) return null
  return <p className={error === true ? 'sb-settings-note sb-settings-error' : 'sb-settings-note'} role="status">{text}</p>
}

/** Settings § Archived chats: Codex's archived-chat list plus safe deletion. */
export function ThreadloomArchivedSection(props: SectionActions): ReactElement {
  const { t, call, uiWorkspace, refreshSessions } = props
  const [rows, setRows] = useState<readonly ArchivedSessionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogSpec | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await call<{ sessions?: readonly ArchivedSessionRow[]; truncated?: boolean }>('list', {
        includeArchived: true,
        archivedOnly: true,
        includeSubagents: false,
        limit: 100,
      })
      setRows((result.sessions ?? []).filter(row => row.archived === true))
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setLoading(false)
    }
  }, [call])

  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return rows
    return rows.filter(row => {
      const haystack = [row.title ?? '', row.cwd ?? '', row.id].join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [rows, query])

  const groups = useMemo(() => {
    const map = new Map<string, ArchivedSessionRow[]>()
    for (const row of filtered) {
      const key = row.cwd ?? ''
      const list = map.get(key)
      if (list === undefined) map.set(key, [row])
      else list.push(row)
    }
    return [...map.entries()].sort((left, right) => left[0].localeCompare(right[0]))
  }, [filtered])

  const unarchive = async (row: ArchivedSessionRow): Promise<void> => {
    setBusy(row.id)
    setError(null)
    setNotice(null)
    try {
      if (uiWorkspace?.unarchiveSession === undefined) throw new Error(t('archived.unavailable'))
      await uiWorkspace.unarchiveSession(row.id)
      setRows(previous => previous.filter(item => item.id !== row.id))
      setNotice(t('archived.restored', { title: row.title ?? shortId(row.id) }))
      refreshSessions?.()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (row: ArchivedSessionRow): Promise<void> => {
    setBusy(row.id)
    setError(null)
    setNotice(null)
    try {
      await call('delete', { sessionId: row.id })
      setRows(previous => previous.filter(item => item.id !== row.id))
      setNotice(t('archived.deleted', { title: row.title ?? shortId(row.id) }))
      refreshSessions?.()
    } catch (reason) {
      const key = deleteErrorKey(reason)
      setError(key === 'menu.delete.failed'
        ? messageOf(reason)
        : t(key, { title: row.title ?? shortId(row.id) }))
      refreshSessions?.()
    } finally {
      setBusy(null)
    }
  }

  const removeAll = async (ids: readonly string[]): Promise<void> => {
    setBusy('all')
    setError(null)
    setNotice(null)
    try {
      let moved = 0
      for (let offset = 0; offset < ids.length; offset += 50) {
        const chunk = ids.slice(offset, offset + 50)
        const result = await call<{ moved?: readonly string[] }>('delete-many', { sessionIds: chunk })
        moved += result.moved?.length ?? 0
      }
      setNotice(t('archived.deletedAll', { count: moved }))
      await load()
      refreshSessions?.()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="sb-settings">
      <style>{CSS}</style>
      <header className="sb-settings-header">
        <div>
          <h2>{t('archived.title')}</h2>
          <p className="sb-settings-subtitle">{t('archived.subtitle')}</p>
        </div>
        <button
          type="button"
          className="sb-settings-button sb-settings-danger"
          disabled={filtered.length === 0 || busy !== null}
          onClick={() => {
            const ids = filtered.map(row => row.id)
            setDialog({
              title: t('dialog.deleteAll.title'),
              body: t('dialog.deleteAll.body', { count: ids.length }),
              confirmLabel: t('archived.deleteAll'),
              danger: true,
              confirm: () => { setDialog(null); void removeAll(ids) },
            })
          }}
        >
          {t('archived.deleteAll')}
        </button>
      </header>
      <div className="sb-settings-toolbar">
        <input
          className="sb-settings-input"
          type="search"
          placeholder={t('archived.search')}
          value={query}
          onChange={event => { setQuery(event.target.value) }}
        />
        <span className="sb-settings-count">{t('archived.count', { count: filtered.length })}</span>
      </div>
      <Notice text={notice} />
      <Notice text={error} error />
      {loading ? <p className="sb-settings-note">{t('archived.loading')}</p> : null}
      {!loading && filtered.length === 0 ? (
        <p className="sb-settings-empty">{query.trim().length === 0 ? t('archived.empty') : t('archived.searchEmpty')}</p>
      ) : null}
      {groups.map(entry => (
        <section key={entry[0]} className="sb-settings-group">
          <h3 className="sb-settings-group-title">
            <span>{entry[0].length === 0 ? t('archived.group.unknown') : entry[0]}</span>
            <span className="sb-settings-count">{entry[1].length}</span>
          </h3>
          <ul className="sb-settings-list">
            {entry[1].map(row => (
              <li key={row.id} className="sb-settings-row">
                <div className="sb-settings-row-main">
                  <span className="sb-settings-row-title">{row.title ?? shortId(row.id)}</span>
                  <span className="sb-settings-row-meta">{formatTime(row.createdAt)} · {shortId(row.id)}</span>
                </div>
                <div className="sb-settings-row-actions">
                  <button
                    type="button"
                    className="sb-settings-button"
                    disabled={busy !== null}
                    onClick={() => { void unarchive(row) }}
                  >
                    {t('archived.unarchive')}
                  </button>
                  <button
                    type="button"
                    className="sb-settings-button sb-settings-danger"
                    disabled={busy !== null}
                    onClick={() => {
                      setDialog({
                        title: t('dialog.delete.title'),
                        body: t('dialog.delete.body', { title: row.title ?? shortId(row.id) }),
                        confirmLabel: t('archived.delete'),
                        danger: true,
                        confirm: () => { setDialog(null); void remove(row) },
                      })
                    }}
                  >
                    {t('archived.delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {dialog === null ? null : <ConfirmDialog spec={dialog} onCancel={() => { setDialog(null) }} />}
    </div>
  )
}


/** Settings § Threadloom: the plugin's configuration form, once, in Settings. */
export function ThreadloomConfigSection(props: SectionActions): ReactElement {
  const { t, configForm } = props
  const snapshot = useConfigSnapshot(configForm)
  return (
    <div className="sb-settings">
      <style>{CSS}</style>
      <header className="sb-settings-header">
        <div>
          <h2>{t('plugin.config.title')}</h2>
          <p className="sb-settings-subtitle">{t('plugin.config.summary')}</p>
        </div>
      </header>
      {snapshot === undefined ? <p className="sb-settings-note">{t('plugin.config.unavailable')}</p> : (
        <SettingsBody snapshot={snapshot} form={configForm} t={t} />
      )}
    </div>
  )
}

/** The five editable fields bound to one DSH config form snapshot. */
function SettingsBody({ snapshot, form, t }: {
  readonly snapshot: ConfigFormSnapshotLike<ClientConfigLike>
  readonly form: ConfigFormLike<ClientConfigLike> | undefined
  readonly t: Translate
}): ReactElement {
  const currentValue = snapshot.value
  const [values, setValues] = useState<ClientConfigLike>(() => currentValue ?? {})
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  useEffect(() => { setValues(currentValue ?? {}) }, [currentValue])
  if (snapshot.status === 'loading') return <p className="sb-settings-note">{t('loading')}</p>
  if (snapshot.status === 'unavailable') return <p className="sb-settings-note">{t('plugin.config.unavailable')}</p>
  const disabled = !snapshot.writable || state === 'saving'
  const save = async (field: string, value: unknown): Promise<void> => {
    setValues(previous => ({ ...previous, [field]: value }))
    setState('saving')
    const legacyField = field === 'inlineMenuEnabled'
      && currentValue?.inlineMenuEnabled === undefined
      && currentValue?.panelEntryEnabled !== undefined
    try {
      const accepted = form === undefined
        ? false
        : await form.mutate([{ op: 'set', path: [legacyField ? 'panelEntryEnabled' : field], value }], snapshot.revision)
      setState(accepted ? 'saved' : 'failed')
    } catch {
      setState('failed')
    }
  }
  return (
    <>
      {!snapshot.writable ? <p className="sb-settings-note">{t('plugin.config.readonly')}</p> : null}
      <div className="sb-settings-form">
        <label className="sb-settings-field">
          <span>{t('plugin.config.retention')}</span>
          <input className="sb-settings-input" type="number" min={0} max={3650} disabled={disabled}
            value={values.trashRetentionDays ?? 30}
            onChange={event => { void save('trashRetentionDays', Number(event.target.value)) }} />
        </label>
        <label className="sb-settings-field">
          <span>{t('plugin.config.settle')}</span>
          <input className="sb-settings-input" type="number" min={0} max={120000} step={100} disabled={disabled}
            value={values.liveSettleTimeoutMs ?? 3000}
            onChange={event => { void save('liveSettleTimeoutMs', Number(event.target.value)) }} />
        </label>
        <label className="sb-settings-field sb-settings-inline">
          <span>{t('plugin.config.cascade')}</span>
          <input className="sb-settings-check" type="checkbox" disabled={disabled}
            checked={values.cascadeSubagents ?? true}
            onChange={event => { void save('cascadeSubagents', event.target.checked) }} />
        </label>
        <label className="sb-settings-field sb-settings-inline">
          <span>{t('plugin.config.inlineMenu')}</span>
          <input className="sb-settings-check" type="checkbox" disabled={disabled}
            checked={inlineMenuEnabledFromConfig(values)}
            onChange={event => { void save('inlineMenuEnabled', event.target.checked) }} />
        </label>

      </div>
      {state === 'saved' ? <p className="sb-settings-note sb-settings-success">{t('plugin.config.saved')}</p> : null}
      {state === 'failed' ? <p className="sb-settings-note sb-settings-error">{t('plugin.config.saveFailed')}</p> : null}
    </>
  )
}

/** Inline styles for all three settings pages (no CSS module: third-party bundle). */
const CSS = [
  '.sb-settings{display:flex;flex-direction:column;gap:14px;max-width:860px}',
  '.sb-settings h2{margin:0;font-size:24px;line-height:1.3}',
  '.sb-settings h3{margin:0;font-size:14px}',
  '.sb-settings-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}',
  '.sb-settings-subtitle{margin:6px 0 0;color:var(--dsw-alias-label-secondary,#667085);font-size:13px}',
  '.sb-settings-toolbar{display:flex;align-items:center;gap:12px}',
  '.sb-settings-toolbar .sb-settings-input{flex:1;max-width:420px}',
  '.sb-settings-count{color:var(--dsw-alias-label-secondary,#667085);font-size:12px;white-space:nowrap}',
  '.sb-settings-input{font:inherit;font-size:13px;padding:6px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer1,transparent);color:inherit;min-width:0}',
  '.sb-settings-check{width:16px;height:16px}',
  '.sb-settings-button{font:inherit;font-size:13px;padding:5px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer}',
  '.sb-settings-button:disabled{opacity:.5;cursor:not-allowed}',
  '.sb-settings-button:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
  '.sb-settings-primary{border-color:var(--dsw-alias-state-success-primary,#2f9e44);color:var(--dsw-alias-state-success-primary,#2f9e44)}',
  '.sb-settings-danger{color:var(--dsw-alias-state-error-primary,#b43c3c)}',
  '.sb-settings-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}',
  '.sb-settings-group{display:flex;flex-direction:column;gap:6px}',
  '.sb-settings-group-title{display:flex;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary,#667085);font-weight:600;font-size:13px;padding:4px 0}',
  '.sb-settings-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 8px;border-radius:8px}',
  '.sb-settings-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
  '.sb-settings-row-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.sb-settings-row-title{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.sb-settings-row-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#667085);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.sb-settings-row-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}',
  '.sb-settings-note{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#667085)}',
  '.sb-settings-empty{padding:28px 8px;text-align:center;color:var(--dsw-alias-label-secondary,#667085);font-size:13px}',
  '.sb-settings-error{color:var(--dsw-alias-state-error-primary,#b43c3c)}',
  '.sb-settings-success{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
  '.sb-settings-form{display:flex;flex-direction:column;gap:10px;max-width:520px}',
  '.sb-settings-field{display:flex;flex-direction:column;gap:4px;font-size:13px}',
  '.sb-settings-inline{flex-direction:row;align-items:center;justify-content:space-between;gap:16px}',
  '.sb-settings-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32)}',
  '.sb-settings-dialog{width:min(440px,calc(100vw - 48px));background:var(--dsw-alias-bg-layer1,#fff);color:inherit;border-radius:10px;padding:20px;display:flex;flex-direction:column;gap:12px;box-shadow:0 18px 48px rgba(0,0,0,.24)}',
  '.sb-settings-dialog h3{margin:0;font-size:16px}',
  '.sb-settings-dialog p{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#667085)}',
  '.sb-settings-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}',
].join('')
