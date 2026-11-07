/**
 * Session-row "..." menu contribution (D-030).
 *
 * Codex keeps chat actions on the row's own menu; the plugin adds the one
 * action the official menu does not own: permanently deleting a chat. The row
 * menu follows the same one-step delete rule as Settings → Archived chats:
 * confirm once, then the chat is gone (no recycle-bin second step).
 *
 * @module dsh-session-butler/client/menu
 */

import type { ReactElement } from 'react'

import { callBridge, deleteErrorKey } from './bridge.js'
import type { ClientConfigLike, ConfigFormLike } from './contract.js'
import { inlineMenuEnabledFromConfig } from './settings.js'

/** Locale translator shape; bound once at registration so the slot needs no locale prop. */
type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Owner props plus the injected actions a row-menu entry needs. */
export interface DeleteMenuItemProps {
  readonly sessionId: string
  readonly displayTitle: string
  readonly useMenuOpenState: () => readonly [boolean, (open: boolean) => void]
  readonly t: Translate
  readonly configForm?: ConfigFormLike<ClientConfigLike>
  readonly refreshSessions?: () => void
}

/** "Delete session" row: confirm once, then permanently delete and refresh the list. */
export function ButlerDeleteMenuItem(props: DeleteMenuItemProps): ReactElement | null {
  const { sessionId, displayTitle, useMenuOpenState, t, configForm, refreshSessions } = props
  const [, setMenuOpen] = useMenuOpenState()
  if (!inlineMenuEnabledFromConfig(configForm?.getSnapshot().value)) return null
  const remove = (): void => {
    setMenuOpen(false)
    const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function'
      ? true
      : window.confirm(t('menu.delete.body', { title: displayTitle }))
    if (!confirmed) return
    void callBridge('delete', { sessionId }).then(
      () => { refreshSessions?.() },
      (error: unknown) => {
        console.error('dsh-session-butler: delete from the row menu failed', error)
        // A failed response may follow a partial delete, or the response may
        // have been lost. Reconcile the sidebar before the user checks it.
        refreshSessions?.()
        if (typeof window === 'undefined' || typeof window.alert !== 'function') return
        window.alert(t(deleteErrorKey(error), { title: displayTitle }))
      },
    )
  }
  return (
    <>
      <style>{MENU_CSS}</style>
      <button type="button" role="menuitem" className="sb-menu-item sb-menu-danger" onClick={remove}>
        {/* Matches the host's IconTrashOutlineRegular artwork and menu icon size. */}
        <svg className="sb-menu-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true" focusable="false">
          <path d="M1.28149 3.88831H14.7187" />
          <path d="M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833" />
          <path d="M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831" />
          <path d="M6.44946 6.98926V11.1238" />
          <path d="M9.55054 6.98926V11.1238" />
        </svg>
        {t('menu.delete')}
      </button>
    </>
  )
}

/** Host menu-cell styling copied from `ui-primitives`'s published Menu.module.css. */
const MENU_CSS = [
  '.sb-menu-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md,6px);background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);text-align:left}',
  '@media (hover:hover){.sb-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}}',
  '.sb-menu-item:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
  '.sb-menu-danger{color:var(--dsw-alias-state-error-primary,#b43c3c)}',
  '.sb-menu-icon{flex:none}',
].join('')
