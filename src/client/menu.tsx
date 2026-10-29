/**
 * Session-row "..." menu contributions.
 *
 * These are the Codex-style entry points: the shipped menu already owns pin,
 * rename, fork, archive and the session id; Threadloom adds the two actions it
 * owns (rich session details and the cross-session library / trash) without a
 * persistent navigation button of its own.
 *
 * The host's `MenuItemButton` is not importable from a third-party bundle, so
 * the rows copy its published cell styling (transparent button, 34px row,
 * hover fill, 13px text) instead of relying on the browser's default button
 * chrome.
 *
 * @module dsh-session-butler/client/menu
 */

import type { ReactElement } from 'react'

import { requestThreadloom } from './navigation.js'

/** Locale translator shape; bound once at registration so the slot needs no locale prop. */
type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Owner props + the menu-dismiss hook delivered to a `sidebar.workspaces.session.menu.item` entry. */
export interface SessionMenuItemPropsLike {
  readonly sessionId: string
  readonly displayTitle: string
  readonly useMenuOpenState: () => readonly [boolean, (open: boolean) => void]
  /** Bound at registration; absent in test doubles. */
  readonly t?: Translate
}

/** Render one menu row button with the host menu cell's visual contract. */
function MenuRow({ label, onClick, separatorBefore = false }: {
  readonly label: string
  readonly onClick: () => void
  readonly separatorBefore?: boolean
}): ReactElement {
  return (
    <>
      <style>{MENU_CSS}</style>
      {separatorBefore ? <div className="sb-menu-separator" role="separator" /> : null}
      <button type="button" role="menuitem" className="sb-menu-item" onClick={onClick}>
        {label}
      </button>
    </>
  )
}

/** "Session details" row: opens the Threadloom panel with the detail dialog. */
export function ThreadloomDetailMenuItem(props: SessionMenuItemPropsLike): ReactElement {
  const { sessionId, useMenuOpenState, t } = props
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuRow
      label={t?.('menu.details') ?? 'Session details…'}
      separatorBefore
      onClick={() => {
        setMenuOpen(false)
        requestThreadloom('detail', sessionId)
      }}
    />
  )
}

/** "Session library" row: opens the library (Sessions + Trash) for every workspace. */
export function ThreadloomLibraryMenuItem(props: SessionMenuItemPropsLike): ReactElement {
  const { useMenuOpenState, t } = props
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuRow
      label={t?.('menu.library') ?? 'Session library…'}
      onClick={() => {
        setMenuOpen(false)
        requestThreadloom('library')
      }}
    />
  )
}

/** Host menu-cell styling copied from `ui-primitives`'s published Menu.module.css. */
const MENU_CSS = `
.sb-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-md, 6px);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, inherit);
  text-align: left;
}
@media (hover: hover) {
  .sb-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12)); }
}
.sb-menu-item:focus-visible { outline: none; background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12)); }
.sb-menu-separator { height: 0; margin: 3px 6px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .2)); }
`
