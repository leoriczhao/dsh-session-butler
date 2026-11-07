/**
 * The plugin — Client half (D-029: settings-only chat management).
 *
 * The plugin no longer owns a session-library page or a navigation button.
 * Everything lives where Codex puts it:
 *   - Settings → Archived chats (list / search / unarchive / delete)
 *   - Settings → Trash (recoverable deletions)
 *   - Settings → Session Butler (the plugin's configuration form)
 * plus one session-row menu action ("Delete session") and the plugin-page
 * health badge/diagnostics. Every contribution degrades silently when the
 * host does not declare its slot.
 *
 * @module dsh-session-butler/client
 */

import { PLUGIN_ID, PLUGIN_ROW_ID } from '../shared/identity.js'
import { callBridge } from './bridge.js'
import type {
  ClientConfigLike,
  ClientContextLike,
  ConfigFormsLike,
  SlotRegistrationLike,
} from './contract.js'
import { EN, NS, ZH } from './locale.js'
import { ButlerDeleteMenuItem } from './menu.js'
import type { DeleteMenuItemProps } from './menu.js'
import { ButlerDetailBadge, ButlerDetailSection } from './plugin-page.js'
import { ButlerArchivedSection, ButlerConfigSection } from './settings.js'
import type { SectionActions } from './settings.js'

// Exported for the client tests; the browser module table itself only uses
// `apply` and `inject`.
export { ButlerArchivedSection, ButlerConfigSection } from './settings.js'
export { ButlerDeleteMenuItem } from './menu.js'

/** Client services this half needs. */
export const inject: string[] = ['slots', 'locale', 'uiWorkspace', 'sessions']

/** Mount the plugin's Client half. */
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

/** One settings section registration row. */
interface SettingsSectionSpec {
  readonly id: string
  readonly order: number
  readonly labelKey: string
  readonly component: (props: SectionActions) => unknown
}

function applyInner(ctx: ClientContextLike): void {
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      // Dictionaries first: the sidebar label resolver and every section render
      // use the bound translator, and locale registration must precede them.
      disposers.push(ctx.locale.register(NS, 'zh', ZH))
      disposers.push(ctx.locale.register(NS, 'en', EN))
      const t = ctx.locale.bind(NS)

      const call = <T,>(method: string, payload?: unknown): Promise<T> => callBridge<T>(method, payload)
      const refreshSessions = (): void => {
        const sessions = ctx.sessions
        if (sessions === undefined) return
        void sessions.refresh().catch(() => {
          // A refresh failure leaves the store's own error state authoritative.
        })
      }

      const configForms = ctx.get?.('configForms') as ConfigFormsLike | undefined
      const configForm = configForms?.get<ClientConfigLike>(PLUGIN_ROW_ID)

      // Bind the optional runtime handlers once; the settings sections never
      // depend on the navigation service owning more than unarchive.
      const unarchiveSession = ctx.uiWorkspace.unarchiveSession
      const uiWorkspace = unarchiveSession === undefined
        ? undefined
        : { unarchiveSession: (sessionId: string) => unarchiveSession.call(ctx.uiWorkspace, sessionId) }

      const actions: SectionActions = {
        t,
        call,
        refreshSessions,
        ...(uiWorkspace === undefined ? {} : { uiWorkspace }),
        ...(configForm === undefined ? {} : { configForm }),
      }

      const sections: readonly SettingsSectionSpec[] = [
        { id: 'archived-sessions', order: 44, labelKey: 'settings.archived', component: ButlerArchivedSection },
        { id: 'session-butler', order: 45, labelKey: 'settings.config', component: ButlerConfigSection },
      ]
      for (const section of sections) {
        disposers.push(ctx.slots.inject('settings.section', () => ctx.slots.register(
          {
            name: 'settings.section',
            id: section.id,
            order: section.order,
            label: () => t(section.labelKey),
            locale: NS,
          },
          ((props: unknown) => section.component({ ...(props as object), ...actions })) as unknown as (props: never) => unknown,
        )))
      }

      // Row menu: the one action the official menu does not own.
      disposers.push(ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
        { name: 'sidebar.workspaces.session.menu.item', id: 'session-butler.delete', order: 470, locale: NS },
        ((props: unknown) => ButlerDeleteMenuItem({
          ...(props as DeleteMenuItemProps),
          t,
          refreshSessions,
          ...(configForm === undefined ? {} : { configForm }),
        })) as unknown as (props: never) => unknown,
      )))

      // DSH Plugins page health surfaces (configuration now lives in Settings).
      const pluginsPageSlots: ReadonlyArray<{
        readonly name: string
        readonly options: SlotRegistrationLike
        readonly component: (props: never) => unknown
      }> = [
        {
          name: 'plugins.detail.badge',
          options: { name: 'plugins.detail.badge', id: 'session-butler-health', locale: NS },
          component: ButlerDetailBadge as unknown as (props: never) => unknown,
        },
        {
          name: 'plugins.detail.section',
          options: { name: 'plugins.detail.section', id: 'session-butler-diagnostics', locale: NS },
          component: ButlerDetailSection as unknown as (props: never) => unknown,
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
  }, 'session-butler: settings sections')
}
