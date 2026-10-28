/**
 * Threadloom — a session-management bundle for DeepSeek Harness.
 *
 * Host half. M1 provides the trash-first delete core as a Host service plus the
 * `/session-butler` human command. M2 adds the Web management page and its HTTP
 * bridge; M3 adds agent tools.
 *
 * Every registration happens inside `apply` through `ctx.effect`/`ctx.on` and
 * returns its cleanup. Optional services are probed with `ctx.get` instead of
 * being injected, because `workspaceRegistry` is absent from headless / ACP
 * compositions.
 *
 * @module dsh-session-butler
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, type ThreadloomConfig } from './config.js'
import { mountBridge } from './host/bridge.js'
import { createButlerCommand } from './host/command.js'
import type {
  AgentsPort,
  ButlerHostContext,
  CommandsPort,
  SessionPersistencePort,
  SessionQueryPort,
  SessionsPort,
  ToolsPort,
  WorkspaceRegistryPort,
} from './host/ports.js'
import { SessionButlerService } from './host/service.js'
import { registerButlerTools } from './host/tools.js'
import { API_PREFIX, PANEL_ID, PLUGIN_ID, PLUGIN_ROW_ID } from './shared/identity.js'

export { Config, PLUGIN_ID, PLUGIN_ROW_ID, PANEL_ID, API_PREFIX }
export type { ThreadloomConfig }
export { SessionButlerService } from './host/service.js'
export type {
  BatchItemResult,
  BatchResult,
  DetailEnrichment,
  SessionDetail,
  SessionHeaderSnapshot,
  TrashListEntry,
  TrashListResult,
  TrashResult,
} from './host/service.js'
export { registerButlerTools } from './host/tools.js'
export { ButlerError } from './shared/errors.js'
export type { ButlerErrorCode } from './shared/errors.js'

/** Cordis plugin name. It must stay equal to the npm package name. */
export const name = PLUGIN_ID

/**
 * Host services this half cannot work without.
 *
 * All four are base-bundle services (audited against the rc.2 release). Optional
 * capabilities — `workspaceRegistry`, the tool registry, and the command
 * registry — are probed in `apply` instead.
 */
export const inject = ['sessionQuery', 'sessionPersistence', 'sessions', 'agents'] as const

/** Mount the Threadloom Host half. */
export function apply(ctx: Context, config: ThreadloomConfig): void {
  const host = ctx as unknown as ButlerHostContext
  const homePath = host.get<(...segments: string[]) => string>('dshHomePath')
  const query = host.get<SessionQueryPort>('sessionQuery')
  const persistence = host.get<SessionPersistencePort>('sessionPersistence')
  if (homePath === undefined || query === undefined || persistence === undefined) {
    host.logger?.warn(
      'dsh-session-butler: required Host services are unavailable; the plugin stays inactive',
    )
    return
  }

  const service = new SessionButlerService({
    sessionsRoot: homePath('sessions'),
    trashRoot: homePath('session-butler', 'trash'),
    query,
    persistence,
    retentionDays: config.trashRetentionDays,
    cascadeSubagents: config.cascadeSubagents,
    permanentDelete: config.permanentDelete,
    // Getters keep late-mounted services visible without delaying this plugin's
    // activation (the Web profile mounts some of them after the bundle rows).
    sessions: () => host.get<SessionsPort>('sessions'),
    agents: () => host.get<AgentsPort>('agents'),
    workspace: () => host.get<WorkspaceRegistryPort>('workspaceRegistry'),
  })

  host.provide('sessionButler', service)

  // The bridge needs webServer + connection, which headless / ACP compositions
  // never provide. Inject them optionally so the command surface still mounts
  // everywhere, and the HTTP bridge appears exactly when a Web app is present.
  if (typeof host.inject === 'function') {
    host.inject(['webServer', 'connection'], scope => mountBridge(scope, service))
    host.inject(['tools'], (scope) => {
      const tools = scope.get<ToolsPort>('tools')
      if (tools === undefined) return
      scope.effect(() => registerButlerTools(tools, service), 'session-butler: tools')
    })
  } else {
    mountBridge(host, service)
    const tools = host.get<ToolsPort>('tools')
    if (tools !== undefined) {
      host.effect(() => registerButlerTools(tools, service), 'session-butler: tools')
    }
  }

  const commands = host.get<CommandsPort>('commands')
  if (commands !== undefined) {
    host.effect(() => commands.register(createButlerCommand(service)), 'session-butler: command')
  }
}
