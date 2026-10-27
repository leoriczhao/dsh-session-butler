/**
 * Stable failure codes for Threadloom's Host operations.
 *
 * The codes cross process boundaries later (the Web bridge in M2), so they are
 * part of the contract: keep them short, stable and prefix-free here; the bridge
 * adds its own transport envelope.
 *
 * @module dsh-session-butler/shared/errors
 */

/** One stable Threadloom failure code. */
export type ButlerErrorCode =
  | 'session-not-found'
  | 'session-running'
  | 'session-locked'
  | 'session-migration-required'
  | 'session-unresolved-path'
  | 'session-cross-device'
  | 'cannot-trash-current'
  | 'trash-not-found'
  | 'trash-conflict'
  | 'trash-corrupt'
  | 'permanent-delete-disabled'
  | 'confirm-mismatch'
  | 'unsupported'
  | 'invalid-request'
  | 'internal'

/** A typed, caller-actionable failure raised by Threadloom's Host service. */
export class ButlerError extends Error {
  readonly code: ButlerErrorCode
  readonly details: Readonly<Record<string, unknown>>
  /** Original failure preserved for diagnostics; never part of the wire code. */
  override readonly cause: unknown

  constructor(
    code: ButlerErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'ButlerError'
    this.code = code
    this.details = options.details ?? {}
    this.cause = options.cause
  }
}

/** Convert an unknown failure into a ButlerError, preserving an existing code. */
export function asButlerError(
  error: unknown,
  code: ButlerErrorCode,
  context: string,
): ButlerError {
  if (error instanceof ButlerError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ButlerError(code, `${context}: ${message}`, { cause: error })
}
