import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { mountBridge } from '../lib/host/bridge.js'
import { ButlerError } from '../lib/shared/errors.js'

function fakeRequest({ method = 'POST', url = '/session-butler/api/status', body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const stream = Readable.from(chunks)
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

function fakeResponse() {
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const response = {
    statusCode: undefined,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status
      Object.assign(this.headers, headers)
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      finish()
    },
    done,
  }
  return response
}

function makeHost({ reject = false } = {}) {
  const routes = []
  const host = {
    get(name) {
      if (name === 'webServer') return { register(route) { routes.push(route); return () => {} } }
      if (name === 'connection') {
        return {
          requestRejection({ headers }) {
            if (reject || headers['x-reject'] === 'yes') return 403
            return undefined
          },
        }
      }
      return undefined
    },
    effect(execute) { return execute() },
    logger: { warn() {} },
  }
  return { host, routes }
}

function makeService() {
  return {
    config: { retentionDays: 30, cascadeSubagents: true, permanentDelete: 'confirm', workspaceAvailable: true },
    async listTrash() { return { entries: [], orphans: 0, trashRoot: '/trash' } },
    async detail(sessionId) { return { id: sessionId, headerSnapshot: { id: sessionId }, descendantIds: ['child-1'] } },
    calls: [],
    async trash(sessionId, options) { this.calls.push(['trash', sessionId, options]); return { trashed: [sessionId], trashRoot: '/trash' } },
    async restore(sessionId) { return { restored: sessionId, path: '/restored' } },
    async purge(sessionId, confirmId) {
      if (confirmId !== sessionId) throw new ButlerError('confirm-mismatch', 'exact id required', { details: { sessionId } })
      return { purged: sessionId }
    },
  }
}

async function call(route, request) {
  const response = fakeResponse()
  await route.handler(request, response)
  await response.done
  return response
}

test('mountBridge registers one prefix route at the documented path', () => {
  const { host, routes } = makeHost()
  mountBridge(host, makeService())
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/session-butler/api')
})

test('status and list-trash answer with the success envelope', async () => {
  const { host, routes } = makeHost()
  const service = makeService()
  mountBridge(host, service)

  const status = await call(routes[0], fakeRequest({ body: {} }))
  assert.equal(status.statusCode, 200)
  assert.equal(JSON.parse(status.body).ok, true)
  assert.equal(JSON.parse(status.body).value.permanentDelete, 'confirm')

  const listing = await call(routes[0], fakeRequest({ url: '/session-butler/api/list-trash', body: {} }))
  assert.equal(listing.statusCode, 200)
  assert.deepEqual(JSON.parse(listing.body).value, { entries: [], orphans: 0, trashRoot: '/trash' })
})

test('trash passes the cascade default and an explicit override', async () => {
  const { host, routes } = makeHost()
  const service = makeService()
  mountBridge(host, service)

  await call(routes[0], fakeRequest({ url: '/session-butler/api/trash', body: { sessionId: 'session-a' } }))
  await call(routes[0], fakeRequest({ url: '/session-butler/api/trash', body: { sessionId: 'session-b', cascade: false } }))
  assert.deepEqual(service.calls, [
    ['trash', 'session-a', { cascade: true }],
    ['trash', 'session-b', { cascade: false }],
  ])
})

test('domain failures stay HTTP 200 with the stable code', async () => {
  const { host, routes } = makeHost()
  mountBridge(host, makeService())
  const response = await call(routes[0], fakeRequest({
    url: '/session-butler/api/purge',
    body: { sessionId: 'session-a', confirmId: 'session-b' },
  }))
  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'confirm-mismatch')
  assert.deepEqual(payload.error.details, { sessionId: 'session-a' })
})

test('protocol failures use 404/405/400/413', async () => {
  const { host, routes } = makeHost()
  mountBridge(host, makeService())

  const unknown = await call(routes[0], fakeRequest({ url: '/session-butler/api/nope', body: {} }))
  assert.equal(unknown.statusCode, 404)
  assert.equal(JSON.parse(unknown.body).error.code, 'invalid-request')

  const wrongMethod = await call(routes[0], fakeRequest({ method: 'GET' }))
  assert.equal(wrongMethod.statusCode, 405)

  const malformed = await call(routes[0], fakeRequest({ body: '{not json' }))
  assert.equal(malformed.statusCode, 400)

  const missingField = await call(routes[0], fakeRequest({ url: '/session-butler/api/trash', body: {} }))
  assert.equal(missingField.statusCode, 400)
  assert.equal(JSON.parse(missingField.body).error.code, 'invalid-request')

  const oversized = await call(routes[0], fakeRequest({ body: JSON.stringify({ blob: 'x'.repeat(70 * 1024) }) }))
  assert.equal(oversized.statusCode, 413)
})

test('the connection fence refuses before dispatch', async () => {
  const { host, routes } = makeHost({ reject: true })
  mountBridge(host, makeService())
  const response = await call(routes[0], fakeRequest())
  assert.equal(response.statusCode, 403)
  assert.equal(response.body, '')
})

test('headless compositions do not mount a route', () => {
  const host = { get: () => undefined, effect: () => {}, logger: { warn() {} } }
  mountBridge(host, makeService())
})
