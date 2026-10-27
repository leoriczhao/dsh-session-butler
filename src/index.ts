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
import { createButlerCommand } from './host/command.js'
import type {
  AgentsPort,
  ButlerHostContext,
  CommandsPort,
  SessionPersistencePort,
  SessionQueryPort,
  SessionsPort,
  WorkspaceRegistryPort,
} from './host/ports.js'
import { SessionButlerService } from './host/service.js'
import { API_PREFIX, PANEL_ID, PLUGIN_ID, PLUGIN_ROW_ID } from './shared/identity.js'

export { Config, PLUGIN_ID, PLUGIN_ROW_ID, PANEL_ID, API_PREFIX }
export type { ThreadloomConfig }
export { SessionButlerService } from './host/service.js'
export type { TrashListEntry, TrashListResult, TrashResult } from './host/service.js'
export { ButlerError } from './shared/errors.js'
export type { ButlerErrorCode } from './shared/errors.js'

/** Cordis plugin name. It must stay equal to the npm package name. */
export const name = PLUGIN_ID

/**
 * Host services this half cannot work without.
 *
 * All five are base-bundle services (audited against the rc.2 release). Optional
 * capabilities — `workspaceRegistry`, `subagent` enumeration, and the command
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

  const sessions = host.get<SessionsPort>('sessions')
  const agents = host.get<AgentsPort>('agents')
  const workspace = host.get<WorkspaceRegistryPort>('workspaceRegistry')
  const service = new SessionButlerService({
    sessionsRoot: homePath('sessions'),
    trashRoot: homePath('session-butler', 'trash'),
    query,
    persistence,
    retentionDays: config.trashRetentionDays,
    cascadeSubagents: config.cascadeSubagents,
    permanentDelete: config.permanentDelete,
    ...(sessions === undefined ? {} : { sessions }),
    ...(agents === undefined ? {} : { agents }),
    ...(workspace === undefined ? {} : { workspace }),
  })

  host.provide('sessionButler', service)

  const commands = host.get<CommandsPort>('commands')
  if (commands !== undefined) {
    host.effect(() => commands.register(createButlerCommand(service)), 'session-butler: command')
  }
}
