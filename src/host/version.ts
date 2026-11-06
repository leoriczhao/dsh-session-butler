/**
 * The installed package version, read once for the health snapshot.
 *
 * The plugin must not import its own `package.json` at build time (the file is
 * not part of the TypeScript program), so the value is read at runtime relative
 * to this module. The same relative path works from `src/host/` and from the
 * built `lib/host/` because both are two levels below the package root.
 *
 * @module dsh-session-butler/host/version
 */

import { readFileSync } from 'node:fs'

/** Installed Threadloom version, or `unknown` when the package metadata is unreadable. */
export const PLUGIN_VERSION: string = (() => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const value = (parsed as { readonly version?: unknown }).version
      if (typeof value === 'string' && value.length > 0) return value
    }
  } catch {
    // A missing or malformed package.json must not make the plugin fail to mount.
  }
  return 'unknown'
})()
