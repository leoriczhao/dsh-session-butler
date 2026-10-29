/**
 * Threadloom request bus and panel opener.
 *
 * Codex-style session management has no dedicated sidebar button: actions live
 * in the Session row's own "..." menu and the full library is opened from
 * there. That menu item is rendered in a different slot (and a different React
 * tree) than the `main` panel, so this module carries the one-shot request
 * between them and installs the layout navigation callback at apply time.
 *
 * @module dsh-session-butler/client/navigation
 */

/** Which Threadloom surface a caller wants the panel to show. */
export type ThreadloomView = 'library' | 'trash' | 'detail'

/** One pending navigation request; `seq` distinguishes repeats of the same view. */
export interface ThreadloomRequest {
  readonly view: ThreadloomView
  readonly sessionId?: string
  readonly seq: number
}

let sequence = 0
let pending: ThreadloomRequest | null = null
const listeners = new Set<() => void>()
let panelOpener: (() => void) | undefined

/**
 * Install the layout-backed panel opener.
 * @param opener - selects the registered Threadloom `main` panel.
 */
export function setPanelOpener(opener: () => void): void {
  panelOpener = opener
}

/** @returns whether the layout service exposed a usable panel opener. */
export function canOpenThreadloom(): boolean {
  return panelOpener !== undefined
}

/** Drop the installed opener and any unconsumed request (plugin disposal). */
export function clearThreadloomNavigation(): void {
  panelOpener = undefined
  pending = null
}

/**
 * Ask the Threadloom panel to show one view, selecting the panel when needed.
 * @param view - library, trash or one session's detail dialog.
 * @param sessionId - target session for `detail`.
 */
export function requestThreadloom(view: ThreadloomView, sessionId?: string): void {
  const next = ++sequence
  pending = sessionId === undefined ? { view, seq: next } : { view, sessionId, seq: next }
  for (const listener of [...listeners]) listener()
  panelOpener?.()
}

/**
 * Read and clear the pending request. The panel consumes it on mount and on
 * each subscription notification, so a remount never replays a stale dialog.
 */
export function consumeThreadloomRequest(): ThreadloomRequest | null {
  const request = pending
  pending = null
  return request
}

/**
 * Subscribe to new requests.
 * @param listener - called after a request is stored, before the panel mounts.
 * @returns unsubscribe.
 */
export function subscribeThreadloomRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
