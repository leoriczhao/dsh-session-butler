/**
 * DSH Plugins-page health contributions (D3.0, trimmed by D-029).
 *
 * Configuration moved into the Settings dialog, so the plugin page now owns
 * only the diagnostic surfaces: the health badge beside the bundle title and
 * the functional diagnostics section. Both degrade silently when a host
 * version does not declare the slots.
 *
 * @module dsh-session-butler/client/plugin-page
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { PLUGIN_ID } from '../shared/identity.js'
import { callBridge } from './bridge.js'
import type { BridgeStatus } from './contract.js'

/** Locale translator shape injected by the slot renderer. */
type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Detail-page subject subset the badge/section decide from. */
interface PluginsSubjectLike {
  readonly kind: 'bundle' | 'row' | 'item'
  readonly pkg?: { readonly name: string }
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

/** The functional health block shared by the detail section and the badge. */
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
                <div key={String(entry.code) + '-' + String(entry.at) + '-' + String(index)} className="sb-plugin-error">
                  <code>{entry.code}</code>
                  {entry.message === undefined ? '' : ' — ' + entry.message}
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
const PLUGIN_CSS = [
  '.sb-plugin-block{display:flex;flex-direction:column;gap:8px;margin:10px 0;font-size:13px;line-height:20px}',
  '.sb-plugin-section{margin:18px 0}',
  '.sb-plugin-head{display:flex;align-items:center;gap:10px}',
  '.sb-plugin-title{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
  '.sb-plugin-status{font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35))}',
  '.sb-plugin-status[data-level="ok"]{color:var(--dsw-alias-state-success,#2f9e44);border-color:currentColor}',
  '.sb-plugin-status[data-level="degraded"]{color:var(--dsw-alias-state-warning,#e0a400);border-color:currentColor}',
  '.sb-plugin-status[data-level="unavailable"]{color:var(--dsw-alias-state-error,#e03131);border-color:currentColor}',
  '.sb-plugin-btn{margin-left:auto;font:inherit;font-size:12px;padding:2px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer}',
  '.sb-plugin-btn:disabled{opacity:.5;cursor:default}',
  '.sb-plugin-note{margin:0;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}',
  '.sb-plugin-note[data-kind="error"]{color:var(--dsw-alias-state-error,#e03131)}',
  '.sb-plugin-note[data-kind="success"]{color:var(--dsw-alias-state-success,#2f9e44)}',
  '.sb-plugin-fact{display:flex;gap:8px}',
  '.sb-plugin-fact-label{color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}',
  '.sb-plugin-errors{display:flex;flex-direction:column;gap:4px}',
  '.sb-plugin-error{font-size:12px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}',
  '.sb-plugin-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px}',
  '.sb-plugin-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-secondary,#888)}',
  '.sb-plugin-dot[data-level="ok"]{background:var(--dsw-alias-state-success,#2f9e44)}',
  '.sb-plugin-dot[data-level="degraded"]{background:var(--dsw-alias-state-warning,#e0a400)}',
  '.sb-plugin-dot[data-level="unavailable"]{background:var(--dsw-alias-state-error,#e03131)}',
].join('')
