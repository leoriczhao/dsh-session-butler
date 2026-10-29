/**
 * DSH Plugins-page contributions (D3.0).
 *
 * The plugin manager declares four slots this half registers into:
 * `plugins.row.config` (the row's configuration page, with a DSH-provided form),
 * `plugins.bundle.config` (a status block on the bundle page),
 * `plugins.detail.badge` (health beside the bundle title), and
 * `plugins.detail.section` (functional diagnostics). All four degrade silently
 * when a host version does not declare them.
 *
 * The components never import Harness Client packages: they use the same
 * structural contracts as the management page and talk to the Host through the
 * same-origin bridge.
 *
 * @module dsh-session-butler/client/plugin-page
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { PLUGIN_ID, PLUGIN_ROW_ID } from '../shared/identity.js'
import { callBridge } from './bridge.js'
import type {
  BridgeStatus,
  ClientConfigLike,
  ConfigFormLike,
  ConfigFormSnapshotLike,
  ConfigPageFormLike,
  ConfigPathOpLike,
} from './contract.js'
import { canOpenThreadloom, requestThreadloom } from './navigation.js'

/** Key the plugin manager addresses a row's configuration page by. */
export const ROW_CONFIG_KEY = `${PLUGIN_ID}#${PLUGIN_ROW_ID}`

/**
 * The DSH settings form for the plugin row, captured at apply time.
 *
 * The Plugins bundle page renders the same fields in its status block so the
 * settings are visible where users look for them ("where is the config page?");
 * both surfaces write through this one form, so the profile patch stays the
 * single source of truth.
 */
let pluginConfigForm: ConfigFormLike<ClientConfigLike> | undefined

/** Install (or clear) the form the bundle-page settings block renders. */
export function setPluginConfigForm(form: ConfigFormLike<ClientConfigLike> | undefined): void {
  pluginConfigForm = form
}

/**
 * Read the inline-menu switch with the pre-D3.0b field as a fallback, so a
 * refreshed Client still works against a Host that has not restarted yet.
 */
export function inlineMenuEnabledFromConfig(value: ClientConfigLike | undefined): boolean {
  return value?.inlineMenuEnabled ?? value?.panelEntryEnabled ?? true
}

/** Locale translator shape injected by the slot renderer. */
type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Detail-page subject subset the badge/section decide from. */
interface PluginsSubjectLike {
  readonly kind: 'bundle' | 'row' | 'item'
  readonly pkg?: { readonly name: string }
}

/** Props the plugin manager passes to a configuration page contribution. */
interface ConfigViewPropsLike {
  readonly view?: 'summary' | 'page'
  /** DSH-owned page form: latest snapshot plus one atomic mutation queue. */
  readonly form?: ConfigPageFormLike | undefined
  readonly t: Translate
}

/** Props the plugin manager passes to a detail contribution. */
interface DetailViewPropsLike {
  readonly subject?: PluginsSubjectLike
  readonly t: Translate
}

/** One health read with its refresh trigger. */
interface HealthState {
  readonly health: BridgeStatus | null
  readonly error: string | null
  readonly loading: boolean
}

/** Read the functional health snapshot from the Host bridge. */
function useHealth(): HealthState & { readonly refresh: () => void } {
  const [state, setState] = useState<HealthState>({ health: null, error: null, loading: true })
  const refresh = useCallback(() => {
    let cancelled = false
    setState(previous => ({ ...previous, loading: true, error: null }))
    void callBridge<BridgeStatus>('status').then(
      health => { if (!cancelled) setState({ health, error: null, loading: false }) },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            health: null,
            error: error instanceof Error ? error.message : String(error),
            loading: false,
          })
        }
      },
    )
    return () => { cancelled = true }
  }, [])
  useEffect(() => refresh(), [refresh])
  return { ...state, refresh }
}

/** Classify the snapshot for the badge and the section headline. */
function healthLevel(health: BridgeStatus | null): 'loading' | 'ok' | 'degraded' | 'unavailable' {
  if (health === null) return 'loading'
  if (health.storage?.trashWritable === false || health.storage?.sessionsRootWritable === false) return 'unavailable'
  if (health.ok === false || health.host?.ok === false || health.bridge?.mounted === false) return 'degraded'
  return 'ok'
}

/** Whether a detail subject belongs to the Threadloom bundle. */
function isThreadloomSubject(subject: PluginsSubjectLike | undefined): boolean {
  if (subject === undefined || subject.kind === 'item') return false
  return subject.pkg?.name === PLUGIN_ID
}

/** Render one boolean/health fact pair. */
function Fact({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="sb-plugin-fact">
      <span className="sb-plugin-fact-label">{label}</span>
      <span className="sb-plugin-fact-value">{value}</span>
    </div>
  )
}

/** The functional health block shared by the bundle page and the detail section. */
function HealthBlock({ health, error, loading, t, onRefresh }: {
  readonly health: BridgeStatus | null
  readonly error: string | null
  readonly loading: boolean
  readonly t: Translate
  readonly onRefresh: () => void
}): ReactElement {
  const level = healthLevel(health)
  const label = level === 'loading'
    ? t('loading')
    : level === 'ok'
      ? t('plugin.health.ok')
      : level === 'degraded'
        ? t('plugin.health.degraded')
        : t('plugin.health.unavailable')
  return (
    <div className="sb-plugin-block" data-health={level}>
      <div className="sb-plugin-head">
        <span className="sb-plugin-title">{t('plugin.health.title')}</span>
        <span className="sb-plugin-status" data-level={level}>{label}</span>
        <button type="button" className="sb-plugin-btn" onClick={onRefresh} disabled={loading}>
          {t('plugin.health.refresh')}
        </button>
      </div>
      {loading && health === null ? <p className="sb-plugin-note">{t('plugin.health.loading')}</p> : null}
      {error !== null ? <p className="sb-plugin-note" data-kind="error">{t('plugin.health.failed', { message: error })}</p> : null}
      {health !== null ? (
        <>
          <p className="sb-plugin-note">{t('plugin.health.version', { version: health.version ?? 'unknown' })}</p>
          {health.counts !== undefined ? (
            <p className="sb-plugin-note">
              {t('plugin.health.counts', {
                sessions: health.counts.sessions,
                trashed: health.counts.trashed,
                live: health.counts.live,
              })}
            </p>
          ) : null}
          {health.storage !== undefined ? (
            <p className="sb-plugin-note">
              {t('plugin.health.storage', {
                trash: health.storage.trashWritable ? t('plugin.health.yes') : t('plugin.health.no'),
                sessions: health.storage.sessionsRootWritable ? t('plugin.health.yes') : t('plugin.health.no'),
              })}
            </p>
          ) : null}
          {health.backends !== undefined ? (
            <p className="sb-plugin-note">
              {t('plugin.health.backends', {
                workspace: health.backends.workspaceRegistry ? t('plugin.health.yes') : t('plugin.health.no'),
                controller: health.backends.sessionController ? t('plugin.health.yes') : t('plugin.health.no'),
                tools: health.backends.tools ? t('plugin.health.yes') : t('plugin.health.no'),
                commands: health.backends.commands ? t('plugin.health.yes') : t('plugin.health.no'),
              })}
            </p>
          ) : null}
          {health.errors !== undefined && health.errors.length > 0 ? (
            <div className="sb-plugin-errors">
              <div className="sb-plugin-fact-label">{t('plugin.health.errors', { count: health.errors.length })}</div>
              {health.errors.slice(-5).map((entry, index) => (
                <div key={`${entry.code}-${String(entry.at)}-${String(index)}`} className="sb-plugin-error">
                  <code>{entry.code}</code>
                  {entry.message === undefined ? '' : ` — ${entry.message}`}
                </div>
              ))}
            </div>
          ) : (
            <p className="sb-plugin-note">{t('plugin.health.noErrors')}</p>
          )}
        </>
      ) : null}
    </div>
  )
}

/** One configuration row: an input plus a short explanation. */
function FieldRow({ label, children }: { readonly label: string; readonly children: React.ReactNode }): ReactElement {
  return (
    <label className="sb-plugin-field">
      <span className="sb-plugin-fact-label">{label}</span>
      {children}
    </label>
  )
}

/** Read the service-owned config form snapshot for a component. */
function useConfigFormSnapshot(
  form: ConfigFormLike<ClientConfigLike> | undefined,
): ConfigFormSnapshotLike<ClientConfigLike> | undefined {
  const [snapshot, setSnapshot] = useState<ConfigFormSnapshotLike<ClientConfigLike> | undefined>(() => form?.getSnapshot())
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

/** The five editable fields, bound to one DSH config form snapshot. */
function SettingsBody({ snapshot, mutate, t }: {
  readonly snapshot: ConfigFormSnapshotLike<unknown>
  readonly mutate: (ops: readonly ConfigPathOpLike[], revision?: number) => Promise<boolean>
  readonly t: Translate
}): ReactElement {
  const currentValue = snapshot.value as ClientConfigLike | undefined
  const [values, setValues] = useState<ClientConfigLike>(() => currentValue ?? {})
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  useEffect(() => { setValues(currentValue ?? {}) }, [currentValue])
  if (snapshot.status === 'loading') return <p className="sb-plugin-note">{t('loading')}</p>
  if (snapshot.status === 'unavailable') return <p className="sb-plugin-note">{t('plugin.config.unavailable')}</p>
  const disabled = !snapshot.writable || state === 'saving'
  const save = async (field: string, value: unknown): Promise<void> => {
    setValues(previous => ({ ...previous, [field]: value }))
    setState('saving')
    // Older Host schemas still call the inline-menu switch `panelEntryEnabled`.
    const legacyField = field === 'inlineMenuEnabled'
      && currentValue?.inlineMenuEnabled === undefined
      && currentValue?.panelEntryEnabled !== undefined
    try {
      const accepted = await mutate(
        [{ op: 'set', path: [legacyField ? 'panelEntryEnabled' : field], value }],
        snapshot.revision,
      )
      setState(accepted ? 'saved' : 'failed')
    } catch {
      setState('failed')
    }
  }
  return (
    <>
      {!snapshot.writable ? <p className="sb-plugin-note">{t('plugin.config.readonly')}</p> : null}
      <FieldRow label={t('plugin.config.retention')}>
        <input
          className="sb-plugin-input" type="number" min={0} max={3650} disabled={disabled}
          value={values.trashRetentionDays ?? 30}
          onChange={event => { void save('trashRetentionDays', Number(event.target.value)) }}
        />
      </FieldRow>
      <FieldRow label={t('plugin.config.settle')}>
        <input
          className="sb-plugin-input" type="number" min={0} max={120000} step={100} disabled={disabled}
          value={values.liveSettleTimeoutMs ?? 3000}
          onChange={event => { void save('liveSettleTimeoutMs', Number(event.target.value)) }}
        />
      </FieldRow>
      <FieldRow label={t('plugin.config.cascade')}>
        <input
          className="sb-plugin-check" type="checkbox" disabled={disabled}
          checked={values.cascadeSubagents ?? true}
          onChange={event => { void save('cascadeSubagents', event.target.checked) }}
        />
      </FieldRow>
      <FieldRow label={t('plugin.config.inlineMenu')}>
        <input
          className="sb-plugin-check" type="checkbox" disabled={disabled}
          checked={inlineMenuEnabledFromConfig(values)}
          onChange={event => { void save('inlineMenuEnabled', event.target.checked) }}
        />
      </FieldRow>
      <FieldRow label={t('plugin.config.permanent')}>
        <select
          className="sb-plugin-input" disabled={disabled}
          value={values.permanentDelete ?? 'disabled'}
          onChange={event => { void save('permanentDelete', event.target.value) }}
        >
          <option value="disabled">{t('plugin.config.permanent.disabled')}</option>
          <option value="confirm">{t('plugin.config.permanent.confirm')}</option>
        </select>
      </FieldRow>
      {state === 'saved' ? <p className="sb-plugin-note" data-kind="success">{t('plugin.config.saved')}</p> : null}
      {state === 'failed' ? <p className="sb-plugin-note" data-kind="error">{t('plugin.config.saveFailed')}</p> : null}
    </>
  )
}

/** The row configuration page contributed to `plugins.row.config`. */
export function ThreadloomRowConfig(props: ConfigViewPropsLike): ReactElement {
  const { view = 'page', form, t } = props
  if (view === 'summary') return <p className="sb-plugin-note">{t('plugin.config.summary')}</p>
  if (form === undefined) {
    return <div className="sb-plugin-block"><p className="sb-plugin-note">{t('plugin.config.unavailable')}</p></div>
  }
  return (
    <div className="sb-plugin-block">
      <div className="sb-plugin-head">
        <span className="sb-plugin-title">{t('plugin.config.title')}</span>
      </div>
      <SettingsBody
        snapshot={form.state}
        mutate={(ops, revision) => form.mutate(ops, revision)}
        t={t}
      />
    </div>
  )
}

/** The bundle-page status block contributed to `plugins.bundle.config`. */
export function ThreadloomBundleConfig({ t }: { readonly t: Translate }): ReactElement {
  const { health, error, loading, refresh } = useHealth()
  return (
    <>
      <HealthBlock health={health} error={error} loading={loading} t={t} onRefresh={refresh} />
      {canOpenThreadloom() ? (
        <div className="sb-plugin-block">
          <button type="button" className="sb-plugin-btn" onClick={() => { requestThreadloom('library') }}>
            {t('plugin.library.open')}
          </button>
        </div>
      ) : null}
    </>
  )
}

/** Top-of-bundle "Configure" action: opens the same settings form in a dialog. */
export function ThreadloomConfigureAction({ subject, t }: {
  readonly subject?: unknown
  readonly t: Translate
}): ReactElement | null {
  const [open, setOpen] = useState(false)
  const configForm = pluginConfigForm
  const configSnapshot = useConfigFormSnapshot(configForm)
  if (!isThreadloomSubject(subject as PluginsSubjectLike | undefined)) return null
  return (
    <>
      <button type="button" className="sb-plugin-btn" onClick={() => { setOpen(true) }}>
        {t('plugin.config.open')}
      </button>
      {open ? (
        <div className="sb-config-overlay" onClick={() => { setOpen(false) }}>
          <div
            className="sb-config-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('plugin.config.title')}
            onClick={event => { event.stopPropagation() }}
          >
            <div className="sb-plugin-head">
              <span className="sb-plugin-title">{t('plugin.config.title')}</span>
              <button type="button" className="sb-plugin-btn" onClick={() => { setOpen(false) }}>
                {t('plugin.config.close')}
              </button>
            </div>
            {configForm === undefined || configSnapshot === undefined
              ? <p className="sb-plugin-note">{t('plugin.config.unavailable')}</p>
              : (
                <SettingsBody
                  snapshot={configSnapshot}
                  mutate={(ops, revision) => configForm.mutate(ops, revision)}
                  t={t}
                />
              )}
          </div>
        </div>
      ) : null}
    </>
  )
}

/** The health badge contributed to `plugins.detail.badge`. */
export function ThreadloomDetailBadge({ subject, t }: DetailViewPropsLike): ReactElement | null {
  const { health } = useHealth()
  if (!isThreadloomSubject(subject)) return null
  const level = healthLevel(health)
  const label = level === 'loading'
    ? t('loading')
    : level === 'ok'
      ? t('plugin.health.ok')
      : level === 'degraded'
        ? t('plugin.health.degraded')
        : t('plugin.health.unavailable')
  return (
    <span className="sb-plugin-badge" data-level={level}>
      <span className="sb-plugin-dot" data-level={level} aria-hidden="true" />
      {label}
    </span>
  )
}

/** The diagnostics section contributed to `plugins.detail.section`. */
export function ThreadloomDetailSection({ subject, t }: DetailViewPropsLike): ReactElement | null {
  const { health, error, loading, refresh } = useHealth()
  if (!isThreadloomSubject(subject)) return null
  return (
    <section className="sb-plugin-section">
      <style>{PLUGIN_CSS}</style>
      <h4 className="sb-plugin-title">{t('plugin.diagnostics.title')}</h4>
      <p className="sb-plugin-note">{t('plugin.diagnostics.hint')}</p>
      <HealthBlock health={health} error={error} loading={loading} t={t} onRefresh={refresh} />
    </section>
  )
}

/** Page-local styles; theme tokens with fallbacks keep the host look. */
const PLUGIN_CSS = `
.sb-plugin-block { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; font-size: 13px; line-height: 20px; }
.sb-plugin-section { margin: 18px 0; }
.sb-plugin-head { display: flex; align-items: center; gap: 10px; }
.sb-plugin-title { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.sb-plugin-status { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35)); }
.sb-plugin-status[data-level="ok"] { color: var(--dsw-alias-state-success, #2f9e44); border-color: currentColor; }
.sb-plugin-status[data-level="degraded"] { color: var(--dsw-alias-state-warning, #e0a400); border-color: currentColor; }
.sb-plugin-status[data-level="unavailable"] { color: var(--dsw-alias-state-error, #e03131); border-color: currentColor; }
.sb-plugin-btn { margin-left: auto; font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35)); background: transparent; color: inherit; cursor: pointer; }
.sb-plugin-btn:disabled { opacity: .5; cursor: default; }
.sb-config-overlay { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, .35); }
.sb-config-dialog { width: min(560px, 100%); max-height: calc(100vh - 48px); overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 20px; border-radius: 12px; background: var(--dsw-alias-bg-layer1, #fff); color: var(--dsw-alias-label-primary, inherit); box-shadow: 0 12px 32px rgba(0, 0, 0, .18); }
.sb-config-dialog .sb-plugin-head { display: flex; align-items: center; justify-content: space-between; }
.sb-plugin-note { margin: 0; color: var(--dsw-alias-label-secondary, rgba(127,127,127,.95)); }
.sb-plugin-note[data-kind="error"] { color: var(--dsw-alias-state-error, #e03131); }
.sb-plugin-note[data-kind="success"] { color: var(--dsw-alias-state-success, #2f9e44); }
.sb-plugin-fact { display: flex; gap: 8px; }
.sb-plugin-fact-label { color: var(--dsw-alias-label-secondary, rgba(127,127,127,.95)); }
.sb-plugin-field { display: flex; flex-direction: column; gap: 4px; }
.sb-plugin-input { font: inherit; font-size: 13px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35)); background: var(--dsw-alias-bg-layer1, transparent); color: inherit; }
.sb-plugin-check { width: 16px; height: 16px; }
.sb-plugin-errors { display: flex; flex-direction: column; gap: 4px; }
.sb-plugin-error { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,.95)); }
.sb-plugin-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.sb-plugin-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-secondary, #888); }
.sb-plugin-dot[data-level="ok"] { background: var(--dsw-alias-state-success, #2f9e44); }
.sb-plugin-dot[data-level="degraded"] { background: var(--dsw-alias-state-warning, #e0a400); }
.sb-plugin-dot[data-level="unavailable"] { background: var(--dsw-alias-state-error, #e03131); }
`
