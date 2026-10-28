/**
 * Threadloom — Client half (M2: Web management page).
 *
 * Registers one keyed `main` panel and one `sidebar.panellist` row through two
 * independent slot injections: the slots are declared by different owner
 * plugins, so a single `main` injection can run before the sidebar slot exists.
 * Locale dictionaries are registered on mount and released with the plugin.
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
export const inject: string[] = ['slots', 'locale', 'uiWorkspace', 'sessions']

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
      // The two slots belong to different owner plugins: `main` is declared by
      // the layout, `sidebar.panellist` only when the sidebar plugin activates.
      // Injecting both through `main` therefore raced the sidebar declaration
      // and threw `slot "sidebar.panellist" is not declared` in a real Web boot.
      disposers.push(ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL_ID, locale: NS, inject: () => actions },
        SessionButlerPage as unknown as (props: never) => unknown,
      )))
      // The sidebar row is optional (panelEntryEnabled). The client half reads
      // the plugin's own volatile Config through the DSH settings service; when
      // that service is absent (older host) the row stays registered.
      const configForms = ctx.get?.('configForms') as ConfigFormsLike | undefined
      const clientConfig = configForms?.get<ClientConfigLike>(PLUGIN_ROW_ID)
      let sidebarDisposer: (() => void) | undefined
      const registerSidebar = (): (() => void) => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => t('nav'), locale: NS },
        SessionButlerIcon as unknown as (props: never) => unknown,
      ))
      const syncSidebar = (): void => {
        const enabled = clientConfig?.getSnapshot().value?.panelEntryEnabled !== false
        if (enabled && sidebarDisposer === undefined) {
          sidebarDisposer = registerSidebar()
        } else if (!enabled && sidebarDisposer !== undefined) {
          sidebarDisposer()
          sidebarDisposer = undefined
        }
      }
      syncSidebar()
      const unsubscribeConfig = clientConfig?.subscribe(syncSidebar)
      disposers.push(() => {
        unsubscribeConfig?.()
        sidebarDisposer?.()
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
