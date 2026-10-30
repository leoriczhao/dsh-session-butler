/**
 * Session-row "..." menu contribution (D-030).
 *
 * Codex keeps chat actions on the row's own menu; Threadloom adds the one
 * action the official menu does not own: permanently deleting a chat. The row
 * menu follows the same one-step delete rule as Settings → Archived chats:
 * confirm once, then the chat is gone (no recycle-bin second step).
 *
 * @module dsh-session-butler/client/menu
 */

import type { ReactElement } from 'react'

import { callBridge } from './bridge.js'
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

/** "Delete chat" row: confirm once, then permanently delete and refresh the list. */
export function ThreadloomDeleteMenuItem(props: DeleteMenuItemProps): ReactElement | null {
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
      },
    )
  }
  return (
    <>
      <style>{MENU_CSS}</style>
      <button type="button" role="menuitem" className="sb-menu-item sb-menu-danger" onClick={remove}>
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
].join('')
