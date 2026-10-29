/**
 * Threadloom configuration schema.
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

/** Configuration accepted by the Threadloom Host half. */
export interface ThreadloomConfig {
  /**
   * How long a session stays in Threadloom's trash before its files may be purged.
   * `0` disables automatic purging; permanent deletion then stays a manual action.
   */
  trashRetentionDays: Volatile<number>
  /**
   * Whether deleting a session also deletes its subagent descendants.
   * Only `origin === 'subagent'` descendants follow the cascade; forks are independent
   * sessions and are never cascaded.
   */
  cascadeSubagents: Volatile<boolean>
  /**
   * Whether the management page offers permanent deletion at all. `disabled` keeps the
   * trash as the only destructive action; `confirm` requires typing the exact session id.
   */
  permanentDelete: Volatile<'disabled' | 'confirm'>
  /**
   * How long to wait for a running session to stop after archiving it, before a
   * trash request is refused. Used by D-013's stop-then-settle pipeline.
   */
  liveSettleTimeoutMs: Volatile<number>
  /**
   * Whether Threadloom adds its actions to every Session row's "..." menu
   * (session details and the session library). Turning it off removes those
   * inline entries only; commands, agent tools and the Plugins-page block stay.
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
      'Days a deleted session stays recoverable in the trash. 0 keeps entries until purged manually.',
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
      'Whether permanent deletion is offered. "confirm" requires typing the exact session id.',
    )
    .volatile(),
  liveSettleTimeoutMs: z
    .number()
    .min(0)
    .max(120_000)
    .default(3_000)
    .description(
      'Milliseconds to wait for a running session to stop after archiving it before refusing the trash request.',
    )
    .volatile(),
  inlineMenuEnabled: z
    .boolean()
    .default(true)
    .description('Add Threadloom actions to each Session row\'s "..." menu.')
    .volatile(),
})
