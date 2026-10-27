/**
 * `/session-butler` — the M1 human surface for the trash pipeline.
 *
 * The command exists so the trash core can be exercised in a profile before the
 * Web management page lands (M2). It is intentionally text-only: no
 * attachments, no interactive confirmation. Permanent deletion therefore
 * requires the exact id twice.
 *
 * @module dsh-session-butler/host/command
 */

import { ButlerError } from '../shared/errors.js'
import type {
  ButlerCommandDefinition,
  ButlerCommandInvocation,
  ButlerCommandResult,
} from './ports.js'
import type { SessionButlerService, TrashListResult } from './service.js'

const USAGE = [
  'Usage: /session-butler <command>',
  '  list                        List trashed sessions',
  '  trash <session-id> [--cascade|--no-cascade]',
  '                              Move a session to the trash',
  '  restore <session-id>        Restore a trashed session',
  '  purge <session-id> <session-id>',
  '                              Permanently delete (requires permanentDelete=confirm)',
].join('\n')

/** Render one trash listing as compact text. */
function renderListing(listing: TrashListResult): string {
  if (listing.entries.length === 0) {
    return `Trash is empty (${listing.trashRoot})${listing.orphans > 0 ? `; ${listing.orphans} orphaned item(s)` : ''}`
  }
  const lines = listing.entries.map((entry) => {
    const parts = [
      entry.id,
      `deleted ${new Date(entry.deletedAt).toISOString()}`,
      entry.expired ? 'retention elapsed' : '',
      entry.cascadeOf === undefined ? '' : `cascaded from ${entry.cascadeOf}`,
      entry.descendants.length === 0 ? '' : `cascade includes ${entry.descendants.length} session(s)`,
    ].filter(part => part !== '')
    return `  ${parts.join(' · ')}`
  })
  const orphanNote = listing.orphans > 0 ? `\n  (${listing.orphans} orphaned item(s) need manual inspection)` : ''
  return [`Trash (${listing.trashRoot}):`, ...lines].join('\n') + orphanNote
}

/** Turn one failure into a stable error line. */
function renderFailure(error: unknown): ButlerCommandResult {
  if (error instanceof ButlerError) {
    const details = Object.keys(error.details).length === 0 ? '' : ` ${JSON.stringify(error.details)}`
    return { kind: 'error', text: `${error.code}: ${error.message}${details}` }
  }
  return { kind: 'error', text: `internal: ${error instanceof Error ? error.message : String(error)}` }
}

/**
 * Execute one command line against the service.
 * @param service - trash service.
 * @param rawInput - text after the command name.
 * @param currentSessionId - session issuing the command; trashing it is refused.
 */
export async function runButlerCommand(
  service: SessionButlerService,
  rawInput: string,
  currentSessionId?: string,
): Promise<ButlerCommandResult> {
  const tokens = rawInput.trim().split(/\s+/).filter(token => token.length > 0)
  const command = tokens[0] ?? 'help'
  try {
    switch (command) {
      case 'help':
        return { kind: 'success', text: USAGE }
      case 'list':
        return { kind: 'success', text: renderListing(await service.listTrash()) }
      case 'trash': {
        const sessionId = tokens[1]
        if (sessionId === undefined) return { kind: 'error', text: 'usage: /session-butler trash <session-id> [--cascade|--no-cascade]' }
        const flags = tokens.slice(2)
        const cascade = flags.includes('--cascade') ? true : flags.includes('--no-cascade') ? false : undefined
        const result = await service.trash(sessionId, {
          ...(cascade === undefined ? {} : { cascade }),
          ...(currentSessionId === undefined ? {} : { currentSessionId }),
        })
        return { kind: 'success', text: `Moved to trash: ${result.trashed.join(', ')}` }
      }
      case 'restore': {
        const sessionId = tokens[1]
        if (sessionId === undefined) return { kind: 'error', text: 'usage: /session-butler restore <session-id>' }
        const result = await service.restore(sessionId)
        return { kind: 'success', text: `Restored: ${result.restored}` }
      }
      case 'purge': {
        const sessionId = tokens[1]
        const confirmId = tokens[2]
        if (sessionId === undefined || confirmId === undefined) {
          return { kind: 'error', text: 'usage: /session-butler purge <session-id> <session-id>' }
        }
        const result = await service.purge(sessionId, confirmId)
        return { kind: 'success', text: `Permanently deleted: ${result.purged}` }
      }
      default:
        return { kind: 'error', text: `unknown command "${command}"\n\n${USAGE}` }
    }
  } catch (error) {
    return renderFailure(error)
  }
}

/**
 * Build the Cordis command definition for one service instance.
 * @param service - trash service exposed by this plugin row.
 */
export function createButlerCommand(service: SessionButlerService): ButlerCommandDefinition {
  return {
    name: 'session-butler',
    description: 'Manage trashed DSH sessions: list, trash, restore, purge',
    handler: (invocation: ButlerCommandInvocation) =>
      runButlerCommand(service, invocation.rawInput, invocation.agent?.session?.id),
  }
}
