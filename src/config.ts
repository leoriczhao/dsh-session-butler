/**
 * Plugin configuration schema.
 *
 * The values are validated by Cordis when the plugin row mounts, and can be overridden
 * from a profile's `cordis.patch.yml`. Keep the defaults safe: the foundation release
 * must never delete or hide anything that the user did not explicitly select.
 *
 * @module dsh-session-butler/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/**
 * Read one schema-resolved configuration value.
 *
 * Fields marked `.volatile()` arrive as live `Volatile` handles (the DSH
 * settings domain edits them through their form); plain objects are accepted
 * too so tests and embedders can pass literal values.
 * @param value - volatile handle or plain value.
 * @returns the current plain value.
 */
export function readConfigValue<T>(value: Volatile<T> | T): T {
  if (typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function') {
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

/** Configuration accepted by the plugin's Host half. */
export interface ButlerConfig {
  /**
   * Days until internal trash entries are marked expired; there is no automatic purge.
   * `0` disables expiry marking. GUI deletion still purges immediately.
   */
  trashRetentionDays: Volatile<number>
  /**
   * Whether deleting a session also deletes its subagent descendants.
   * Only `origin === 'subagent'` descendants follow the cascade; forks are independent
   * sessions and are never cascaded.
   */
  cascadeSubagents: Volatile<boolean>
  /**
   * Compatibility setting for the Host service's explicit purge operation.
   * `confirm` requires the exact session id; GUI deletion bypasses this gate.
   */
  permanentDelete: Volatile<'disabled' | 'confirm'>
  /**
   * How long to wait for the owner of a loaded session to release it before a
   * delete request is refused. The plugin does not stop or archive the session.
   */
  liveSettleTimeoutMs: Volatile<number>
  /**
   * Whether the plugin adds deletion to every Session row's "..." menu.
   * Turning it off hides only that entry; settings, agent tools and diagnostics stay.
   */
  inlineMenuEnabled: Volatile<boolean>
}

/**
 * Cordis Config schema. Cordis validates the row's `config` against this schema at
 * activation, applies the defaults, and exposes the resolved values to `apply`.
 */
export const Config = z.object({
  trashRetentionDays: z
    .number()
    .min(0)
    .max(3650)
    .default(30)
    .description(
      'Days until internal trash entries are marked expired; no automatic purge. 0 disables expiry marking.',
    )
    .volatile(),
  cascadeSubagents: z
    .boolean()
    .default(true)
    .description(
      'Also delete subagent descendants when a session is deleted. Forks are never cascaded.',
    )
    .volatile(),
  permanentDelete: z
    .union(['disabled', 'confirm'])
    .default('disabled')
    .description(
      'Gate for explicit Host purge calls: "confirm" requires the exact session id. Does not restrict GUI deletion.',
    )
    .volatile(),
  liveSettleTimeoutMs: z
    .number()
    .min(0)
    .max(120_000)
    .default(3_000)
    .description(
      'Milliseconds to wait for a loaded session to be released before refusing deletion. The plugin does not stop the session.',
    )
    .volatile(),
  inlineMenuEnabled: z
    .boolean()
    .default(true)
    .description('Add the plugin\'s actions to each Session row\'s "..." menu.')
    .volatile(),
})
