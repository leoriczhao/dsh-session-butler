/**
 * Threadloom configuration schema.
 *
 * The values are validated by Cordis when the plugin row mounts, and can be overridden
 * from a profile's `cordis.patch.yml`. Keep the defaults safe: the foundation release
 * must never delete or hide anything that the user did not explicitly select.
 *
 * @module dsh-session-butler/config
 */

import z from '@deepseek-ai/schemastery'

/** Configuration accepted by the Threadloom Host half. */
export interface ThreadloomConfig {
  /**
   * How long a session stays in Threadloom's trash before its files may be purged.
   * `0` disables automatic purging; permanent deletion then stays a manual action.
   */
  trashRetentionDays: number
  /**
   * Whether deleting a session also deletes its subagent descendants.
   * Only `origin === 'subagent'` descendants follow the cascade; forks are independent
   * sessions and are never cascaded.
   */
  cascadeSubagents: boolean
  /**
   * Whether the management page offers permanent deletion at all. `disabled` keeps the
   * trash as the only destructive action; `confirm` requires typing the exact session id.
   */
  permanentDelete: 'disabled' | 'confirm'
}

/**
 * Cordis Config schema. Cordis validates the row's `config` against this schema at
 * activation, applies the defaults, and exposes the resolved values to `apply`.
 */
export const Config: z<ThreadloomConfig> = z.object({
  trashRetentionDays: z
    .number()
    .min(0)
    .max(3650)
    .default(30)
    .description(
      'Days a deleted session stays recoverable in the trash. 0 keeps entries until purged manually.',
    ),
  cascadeSubagents: z
    .boolean()
    .default(true)
    .description(
      'Also delete subagent descendants when a session is deleted. Forks are never cascaded.',
    ),
  permanentDelete: z
    .union(['disabled', 'confirm'])
    .default('disabled')
    .description(
      'Whether permanent deletion is offered. "confirm" requires typing the exact session id.',
    ),
})
