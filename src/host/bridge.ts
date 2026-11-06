/**
 * Host HTTP bridge for the Web management page (M2).
 *
 * A published npm plugin cannot add a Typert `@Remote` namespace, so the page
 * talks to the Host through one same-origin prefix route. Every request is
 * admitted by the connection's browser-trust fence first, then dispatched with a
 * small JSON envelope:
 *
 * ```
 * POST /session-butler/api/<method>
 *   -> { ok: true, value } | { ok: false, error: { code, message, details? } }
 * ```
 *
 * Domain failures are `ok:false` at HTTP 200 (the page renders the code);
 * protocol failures use 400/404/405/413 and a JSON error envelope too.
 *
 * @module dsh-session-butler/host/bridge
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { ButlerError } from '../shared/errors.js'
import { API_PREFIX } from '../shared/identity.js'
import type { ButlerHostContext, ConnectionPort, WebServerPort } from './ports.js'
import type { SessionButlerService } from './service.js'

/** Maximum accepted JSON request body. */
const MAX_BODY_BYTES = 64 * 1024

/** Absolute prefix path of the bridge. */
const ROUTE_PATH = `/${API_PREFIX}`

const METHODS = [
  'status',
  'list',
  'detail',
  'delete',
  'delete-many',
  'trash',
  'trash-many',
  'restore',
  'restore-many',
  'purge',
  'list-trash',
] as const
type BridgeMethod = (typeof METHODS)[number]

/** A request body that exceeds the body budget. */
class BodyTooLargeError extends Error {}

/** Send one JSON document. */
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Send a protocol-level failure in the same envelope shape as domain failures. */
function sendProtocolError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { ok: false, error: { code, message } })
}

/** Read and parse the bounded JSON body. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) {
      request.destroy()
      throw new BodyTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** Resolve the bridge method from the request URL, or undefined when unknown. */
function methodOf(url: string | undefined): BridgeMethod | undefined {
  let pathname: string
  try {
    pathname = new URL(url ?? '/', 'http://dsh.invalid').pathname
  } catch {
    return undefined
  }
  if (!pathname.startsWith(`${ROUTE_PATH}/`)) return undefined
  const suffix = pathname.slice(ROUTE_PATH.length + 1)
  return (METHODS as readonly string[]).includes(suffix) ? (suffix as BridgeMethod) : undefined
}

/** Require a string field on a JSON object body. */
function field(body: unknown, name: string): string {
  const record = body as Record<string, unknown> | null
  const value = record?.[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ButlerError('invalid-request', `missing string field "${name}"`)
  }
  return value
}

/** Optional boolean field with a default. */
function booleanField(body: unknown, name: string, fallback: boolean): boolean {
  const record = body as Record<string, unknown> | null
  const value = record?.[name]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new ButlerError('invalid-request', `field "${name}" must be a boolean`)
  return value
}

/** Optional boolean field that stays absent when the caller omits it. */
function optionalBooleanField(body: unknown, name: string): boolean | undefined {
  const record = body as Record<string, unknown> | null
  const value = record?.[name]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new ButlerError('invalid-request', `field "${name}" must be a boolean`)
  return value
}

/** Non-empty string array field (deduplicated by the service). */
function stringArrayField(body: unknown, name: string): string[] {
  const record = body as Record<string, unknown> | null
  const value = record?.[name]
  if (!Array.isArray(value) || value.length === 0) {
    throw new ButlerError('invalid-request', `field "${name}" must be a non-empty array of session id strings`)
  }
  if (value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new ButlerError('invalid-request', `field "${name}" must contain only non-empty session id strings`)
  }
  return value as string[]
}

/** Optional page-size field. */
function optionalNumberField(body: unknown, name: string): number | undefined {
  const record = body as Record<string, unknown> | null
  const value = record?.[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ButlerError('invalid-request', `field "${name}" must be a finite number`)
  }
  return value
}

/** Optional trimmed string field. */
function optionalStringField(body: unknown, name: string): string | undefined {
  const record = body as Record<string, unknown> | null
  const value = record?.[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ButlerError('invalid-request', `field "${name}" must be a string`)
  return value.trim().length === 0 ? undefined : value.trim()
}

/** Dispatch one admitted request. */
async function dispatch(service: SessionButlerService, method: BridgeMethod, body: unknown): Promise<unknown> {
  switch (method) {
    case 'status':
      return service.health()
    case 'list-trash':
      return service.listTrash()
    case 'list': {
      const query = optionalStringField(body, 'query')
      const cwd = optionalStringField(body, 'cwd')
      const includeArchived = optionalBooleanField(body, 'includeArchived')
      const archivedOnly = optionalBooleanField(body, 'archivedOnly')
      const includeSubagents = optionalBooleanField(body, 'includeSubagents')
      const limit = optionalNumberField(body, 'limit')
      return service.listSessions({
        ...(query === undefined ? {} : { query }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(includeArchived === undefined ? {} : { includeArchived }),
        ...(archivedOnly === undefined ? {} : { archivedOnly }),
        ...(includeSubagents === undefined ? {} : { includeSubagents }),
        ...(limit === undefined ? {} : { limit }),
      })
    }
    case 'detail':
      return service.detail(field(body, 'sessionId'))
    case 'delete':
      return service.delete(field(body, 'sessionId'), { cascade: booleanField(body, 'cascade', service.config.cascadeSubagents) })
    case 'delete-many':
      return service.deleteMany(stringArrayField(body, 'sessionIds'), {
        cascade: booleanField(body, 'cascade', service.config.cascadeSubagents),
      })
    case 'trash':
      return service.trash(field(body, 'sessionId'), { cascade: booleanField(body, 'cascade', service.config.cascadeSubagents) })
    case 'trash-many':
      return service.trashMany(stringArrayField(body, 'sessionIds'), {
        cascade: booleanField(body, 'cascade', service.config.cascadeSubagents),
      })
    case 'restore':
      return service.restore(field(body, 'sessionId'))
    case 'restore-many':
      return service.restoreMany(stringArrayField(body, 'sessionIds'))
    case 'purge':
      return service.purge(field(body, 'sessionId'), field(body, 'confirmId'))
  }
}

/** Own the full HTTP lifecycle for one bridge request. */
async function handle(
  connection: ConnectionPort,
  service: SessionButlerService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const rejection = connection.requestRejection({ headers: request.headers })
  if (rejection !== undefined) {
    response.writeHead(rejection)
    response.end()
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }
  const method = methodOf(request.url)
  if (method === undefined) {
    sendProtocolError(response, 404, 'invalid-request', 'unknown endpoint')
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(request)
  } catch (error) {
    if (error instanceof BodyTooLargeError) sendProtocolError(response, 413, 'invalid-request', error.message)
    else sendProtocolError(response, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
    return
  }
  try {
    sendJson(response, 200, { ok: true, value: await dispatch(service, method, body) })
  } catch (error) {
    service.recordError(
      error instanceof ButlerError ? error.code : 'internal',
      error instanceof Error ? error.message : String(error),
    )
    if (error instanceof ButlerError && error.code === 'invalid-request') {
      sendProtocolError(response, 400, error.code, error.message)
    } else if (error instanceof ButlerError) {
      sendJson(response, 200, {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
        },
      })
    } else {
      sendJson(response, 500, {
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

/**
 * Mount the bridge when the composition provides a Web server and connection
 * fence; headless / ACP compositions keep only the command surface.
 */
export function mountBridge(host: ButlerHostContext, service: SessionButlerService): void {
  const webServer = host.get<WebServerPort>('webServer')
  const connection = host.get<ConnectionPort>('connection')
  if (webServer === undefined || connection === undefined) {
    host.logger?.warn('dsh-session-butler: webServer/connection unavailable; management bridge stays unmounted')
    return
  }
  host.effect(
    () => webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: (request, response) => handle(connection, service, request, response),
    }),
    'session-butler: bridge',
  )
}
