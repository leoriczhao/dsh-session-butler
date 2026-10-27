/**
 * Threadloom Client half (Web) — foundation release.
 *
 * This module is bundled into a DSH classic-script module factory
 * (`window.__ModuleLoader__.load({ id, factory })`) and executed in the browser module
 * table. It may only `require` the platform seed modules (react, react/jsx-runtime,
 * react-dom, react-dom/client, @deepseek-ai/cordis, zod, @tanstack/react-virtual,
 * @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
 * @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit) or modules
 * declared in `dsh.client.external`. Everything else is reached through Cordis services
 * listed in `inject` below.
 *
 * The MVP registers two things in the same effect lifecycle:
 * 1. a keyed `main` panel (`ctx.slots.register({ name: 'main', key: PANEL_ID, locale }, Page)`);
 * 2. its sidebar entry (`ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID }, Icon)`).
 * Register the page first and the row second; registering the row without the page makes
 * the sidebar throw `main panel "..." is not registered` when clicked.
 *
 * @module dsh-session-butler/client
 */

/**
 * Cordis Client services required by this half.
 *
 * Empty for the foundation release. The MVP grows this to
 * `['slots', 'locale', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace', 'layout',
 * 'remote', 'remote.session', 'remote.workspace']`; `remote.<ns>` must be listed even when
 * `remote` is already listed.
 */
export const inject: string[] = []

/**
 * Mount the Threadloom Client half.
 * @param _ctx - Client Cordis context (typed once the UI lands; the foundation has no UI).
 */
export function apply(_ctx: unknown): void {
  // Intentionally empty in the foundation release.
}
