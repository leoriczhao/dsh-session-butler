/**
 * Same-origin client for the Host management bridge.
 *
 * Requests are document-relative (`session-butler/api/<method>`), so the page
 * keeps working behind a reverse-proxy mount prefix, and every response uses the
 * `{ ok, value | error }` envelope documented in `host/bridge.ts`.
 *
 * @module dsh-session-butler/client/bridge
 */

import { API_PREFIX } from '../shared/identity.js'

/** A domain failure returned by the Host bridge. */
export class BridgeError extends Error {
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>
  readonly status: number

  constructor(status: number, code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'BridgeError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** Select actionable, localized guidance for a failed session deletion. */
export function deleteErrorKey(error: unknown): string {
  const code = error instanceof BridgeError ? error.code : undefined
  if (code === 'session-running') return 'menu.delete.running'
  if (code === 'session-in-use') return 'menu.delete.inUse'
  if (code === 'session-locked') return 'menu.delete.locked'
  return 'menu.delete.failed'
}

/** One wire envelope. */
interface Envelope {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly details?: unknown }
}

/**
 * Call one Host bridge method.
 * @param method - bridge method (`status`, `list`, `detail`, `trash`, `trash-many`,
 * `restore`, `restore-many`, `purge`, `list-trash`).
 * @param payload - JSON body; omitted sends `{}`.
 * @throws {BridgeError} transport or domain failure, with the stable Host code.
 */
export async function callBridge<T>(method: string, payload: unknown = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_PREFIX}/${method}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new BridgeError(0, 'transport', error instanceof Error ? error.message : String(error))
  }
  if (response.status === 401 || response.status === 403) {
    throw new BridgeError(response.status, 'forbidden', 'the management bridge refused this page')
  }
  let envelope: Envelope
  try {
    envelope = (await response.json()) as Envelope
  } catch {
    throw new BridgeError(response.status, 'transport', `bridge answered HTTP ${response.status} without JSON`)
  }
  if (envelope.ok === true) return envelope.value as T
  const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'internal'
  const message = typeof envelope.error?.message === 'string' ? envelope.error.message : `bridge failed with ${code}`
  const details = typeof envelope.error?.details === 'object' && envelope.error.details !== null
    ? envelope.error.details as Record<string, unknown>
    : {}
  throw new BridgeError(response.status, code, message, details)
}
