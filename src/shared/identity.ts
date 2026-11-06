/**
 * Stable identifiers shared by the Host and Web halves.
 *
 * These strings leak into persisted profile patches, the browser module table, HTTP
 * routes and user-facing URLs, so they must never change after the first release.
 *
 * @module dsh-session-butler/shared/identity
 */

/** npm package name. It is also the Cordis plugin name and the browser module id. */
export const PLUGIN_ID = 'dsh-session-butler'

/** Loader row id declared in `cordis.patch.yml`; profile patches target it by id. */
export const PLUGIN_ROW_ID = 'session-butler'

/**
 * Document-relative HTTP prefix of the Host bridge that owns trash/delete.
 *
 * The Client half fetches `session-butler/api/<method>` without a leading slash so the
 * page keeps working behind a reverse-proxy mount prefix.
 */
export const API_PREFIX = 'session-butler/api'
