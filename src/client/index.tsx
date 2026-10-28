/**
 * Threadloom — Client half (M2: Web management page).
 *
 * Registers one keyed `main` panel and one `sidebar.panellist` row in the same
 * slot injection so the row can never outlive its page. Locale dictionaries are
 * registered on mount and released with the rest of the plugin.
 *
 * @module dsh-session-butler/client
 */

import { PANEL_ID } from '../shared/identity.js'
import { callBridge } from './bridge.js'
import type { ClientContextLike, PageActions } from './contract.js'
import { EN, NS, ZH } from './locale.js'
import { SessionButlerIcon, SessionButlerPage } from './page.js'

/**
 * Client services this half needs: slot registration, locale dictionaries, the
 * workspace navigation service (open a session from the management page), and
 * the session store's manual refresh after a trash/restore.
 */
export const inject: string[] = ['slots', 'locale', 'uiWorkspace', 'sessions']

/** Mount the Threadloom Client half. */
export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => {
    const unregisterZh = ctx.locale.register(NS, 'zh', ZH)
    const unregisterEn = ctx.locale.register(NS, 'en', EN)
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

    // One injection owns both registrations: the sidebar row appears exactly
    // when the panel slot is declared, and both disposers run in one cleanup.
    const disposeInjection = ctx.slots.inject('main', () => {
      const offPanel = ctx.slots.register(
        { name: 'main', key: PANEL_ID, locale: NS, inject: () => actions },
        SessionButlerPage as unknown as (props: never) => unknown,
      )
      const offRow = ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => t('nav'), locale: NS },
        SessionButlerIcon as unknown as (props: never) => unknown,
      )
      return () => {
        offRow()
        offPanel()
      }
    })

    return () => {
      try {
        disposeInjection()
      } catch {
        // The slot owner already tore down this injection.
      }
      unregisterEn()
      unregisterZh()
    }
  }, 'session-butler: management page')
}
