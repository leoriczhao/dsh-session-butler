/**
 * Threadloom — a session-management bundle for DeepSeek Harness.
 *
 * Host half. The foundation release only validates its config and exports the stable
 * identity used by the Web half. The MVP adds, in this order:
 *
 * 1. a `threadloom` Host service (list/detail/trash/restore/purge/cascade) built on
 *    `sessionQuery`, `sessionPersistence`, `storageDomain`, and the optional
 *    `workspaceRegistry` / `sessionTitle` / `subagents` capabilities;
 * 2. a `session-butler/api` prefix route registered with `ctx.webServer` and guarded by
 *    `ctx.connection.requestRejection`, because a published npm plugin cannot add a
 *    Typert `@Remote` namespace to the Web Client;
 * 3. a `/threadloom` human command (`ctx.commands.register`) so the same operations work
 *    without the management page;
 * 4. read-only agent tools (`ctx.tools.register`) for list/detail only.
 *
 * Every registration must happen inside `apply` through `ctx.effect`/`ctx.on` and return
 * its cleanup.
 *
 * @module dsh-session-butler
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, type ThreadloomConfig } from './config.js'
import { API_PREFIX, PANEL_ID, PLUGIN_ID, PLUGIN_ROW_ID } from './shared/identity.js'

export { Config, PLUGIN_ID, PLUGIN_ROW_ID, PANEL_ID, API_PREFIX }
export type { ThreadloomConfig }

/** Cordis plugin name. It must stay equal to the npm package name. */
export const name = PLUGIN_ID

/**
 * Host services this half requires.
 *
 * Empty for the foundation release. The MVP fills this with the base-bundle services it
 * cannot work without (`sessionQuery`, `sessionPersistence`, `storageDomain`, `commands`,
 * and `tools`), and probes optional services with `ctx.get(...)` instead of injecting
 * them: `workspaceRegistry`/`sessionTitle`/`subagents` are absent from headless profiles.
 */
export const inject: string[] = []

/**
 * Mount the Threadloom Host half.
 * @param ctx - Host context owned by this plugin row.
 * @param config - Validated plugin configuration from the row's `config`.
 */
export function apply(_ctx: Context, _config: ThreadloomConfig): void {
  // Intentionally empty in the foundation release; see the module comment for the plan.
}
