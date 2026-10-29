/**
 * Threadloom — Client half (M2: Web management page).
 *
 * Registers one keyed `main` panel plus Codex-style inline contributions to
 * each Session row's "..." menu. There is intentionally no persistent sidebar
 * "session manager" button: the library is opened from the row menu or from the
 * Plugins page, and the panel is navigated through the layout service.
 *
 * @module dsh-session-butler/client
 */

import { PANEL_ID, PLUGIN_ID, PLUGIN_ROW_ID } from '../shared/identity.js'
import { callBridge } from './bridge.js'
import type {
  ClientConfigLike,
  ClientContextLike,
  ConfigFormsLike,
  PageActions,
  SlotRegistrationLike,
} from './contract.js'
import { EN, NS, ZH } from './locale.js'
import { ThreadloomDetailMenuItem, ThreadloomLibraryMenuItem } from './menu.js'
import type { SessionMenuItemPropsLike } from './menu.js'
import { clearThreadloomNavigation, setPanelOpener } from './navigation.js'
import { SessionButlerIcon, SessionButlerPage, SessionDetailView } from './page.js'
import {
  ROW_CONFIG_KEY,
  ThreadloomBundleConfig,
  ThreadloomDetailBadge,
  ThreadloomDetailSection,
  ThreadloomRowConfig,
} from './plugin-page.js'

/**
 * Client services this half needs: slot registration, locale dictionaries, the
 * workspace navigation service (open a session from the management page), and
 * the session store's manual refresh after a trash/restore.
 */
export const inject: string[] = ['slots', 'locale', 'uiWorkspace', 'sessions', 'layout']

export { SessionButlerIcon, SessionButlerPage, SessionDetailView }

/** Mount the Threadloom Client half. */
export function apply(ctx: ClientContextLike): void {
  try {
    applyInner(ctx)
  } catch (error) {
    // The boot audit reports only the fiber state; keep the real stack in the
    // browser console so an activation failure stays diagnosable.
    console.error('dsh-session-butler: client apply failed', error)
    throw error
  }
}

function applyInner(ctx: ClientContextLike): void {
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      // Dictionaries first: the sidebar label resolver and the page render use
      // the bound translator, and locale registration must precede them.
      disposers.push(ctx.locale.register(NS, 'zh', ZH))
      disposers.push(ctx.locale.register(NS, 'en', EN))
      const t = ctx.locale.bind(NS)
      const actions: PageActions = {
        call: (method, payload) => callBridge(method, payload),
        openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
        refreshSessions: () => {
          const sessions = ctx.sessions
          if (sessions === undefined) return
          void sessions.refresh().catch(() => {
            // A refresh failure leaves the store's own error state authoritative.
          })
        },
      }
      // The page registers in the layout-declared `main` slot; every other
      // contribution lives in its own owner-declared slot and injects
      // independently, so a host that only declares one of them still boots.
      disposers.push(ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL_ID, locale: NS, inject: () => actions },
        SessionButlerPage as unknown as (props: never) => unknown,
      )))
      // Codex has no "session management" button, and neither do we: the panel
      // is opened through the layout service from the Session row's own "..."
      // menu or from the Plugins page. Without that service the panel stays
      // registered but gets no entry point, so no dead buttons are rendered.
      const layout = ctx.layout ?? (ctx.get?.('layout') as { selectPanel?: (panelId: string | null) => void } | undefined)
      const selectPanel = layout?.selectPanel?.bind(layout)
      const openPanel = selectPanel === undefined
        ? undefined
        : (): void => { selectPanel(PANEL_ID) }
      if (openPanel !== undefined) setPanelOpener(openPanel)

      // Session-row "..." menu contributions (see menu.tsx). The row menu slot
      // is declared by the workspace browser; injecting waits for it, and hosts
      // without that slot simply never mount these entries.
      const configForms = ctx.get?.('configForms') as ConfigFormsLike | undefined
      const clientConfig = configForms?.get<ClientConfigLike>(PLUGIN_ROW_ID)
      let menuDisposers: Array<() => void> = []
      const disposeMenus = (): void => {
        for (const dispose of menuDisposers.reverse()) {
          try {
            dispose()
          } catch {
            // The slot owner already tore this registration down.
          }
        }
        menuDisposers = []
      }
      const registerMenus = (): void => {
        if (openPanel === undefined || menuDisposers.length > 0) return
        const detail = (props: SessionMenuItemPropsLike): unknown => ThreadloomDetailMenuItem({ ...props, t })
        const library = (props: SessionMenuItemPropsLike): unknown => ThreadloomLibraryMenuItem({ ...props, t })
        menuDisposers.push(ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'threadloom.detail', order: 460, locale: NS },
          detail as unknown as (props: never) => unknown,
        )))
        menuDisposers.push(ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'threadloom.library', order: 470, locale: NS },
          library as unknown as (props: never) => unknown,
        )))
      }
      const syncMenus = (): void => {
        const enabled = clientConfig?.getSnapshot().value?.inlineMenuEnabled !== false
        if (enabled) registerMenus()
        else disposeMenus()
      }
      syncMenus()
      const unsubscribeConfig = clientConfig?.subscribe(syncMenus)
      disposers.push(() => {
        unsubscribeConfig?.()
        disposeMenus()
        clearThreadloomNavigation()
      })

      // DSH Plugins page contributions (D3.0). Each slot is declared by the
      // plugin manager's page; inject waits for the declaration, so hosts
      // without these slots simply never mount them.
      const pluginsPageSlots: ReadonlyArray<{
        readonly name: string
        readonly options: SlotRegistrationLike
        readonly component: (props: never) => unknown
      }> = [
        {
          name: 'plugins.row.config',
          options: { name: 'plugins.row.config', key: ROW_CONFIG_KEY, locale: NS },
          component: ThreadloomRowConfig as unknown as (props: never) => unknown,
        },
        {
          name: 'plugins.bundle.config',
          options: { name: 'plugins.bundle.config', key: PLUGIN_ID, locale: NS },
          component: ThreadloomBundleConfig as unknown as (props: never) => unknown,
        },
        {
          name: 'plugins.detail.badge',
          options: { name: 'plugins.detail.badge', id: 'threadloom-health', locale: NS },
          component: ThreadloomDetailBadge as unknown as (props: never) => unknown,
        },
        {
          name: 'plugins.detail.section',
          options: { name: 'plugins.detail.section', id: 'threadloom-diagnostics', locale: NS },
          component: ThreadloomDetailSection as unknown as (props: never) => unknown,
        },
      ]
      for (const slot of pluginsPageSlots) {
        disposers.push(ctx.slots.inject(slot.name, () => ctx.slots.register(slot.options, slot.component)))
      }
    } catch (error) {
      // A retried activation must not find a half-registered namespace or slot.
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // The owner already tore this registration down.
        }
      }
      throw error
    }

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // The slot owner already tore down this registration.
        }
      }
    }
  }, 'session-butler: management page')
}
