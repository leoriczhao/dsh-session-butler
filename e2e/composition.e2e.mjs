/**
 * L1 real-composition lane: pack this checkout with npm's publish allowlist,
 * boot it inside a real `dsh web` profile, then observe the Host's real HTTP
 * surface. No fake Context and no direct imports of the plugin's Host module:
 * the only way this test can pass is through the Loader finding the package,
 * applying it, and the Web server mounting its bridge.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PACKAGE_JSON,
  authenticateWeb,
  callBridge,
  createDshHome,
  startDshWeb,
} from './support/dsh.mjs'

test('the packed plugin composes into a real dsh web profile', { timeout: 120_000 }, async () => {
  const fixture = await createDshHome()
  let server
  try {
    server = await startDshWeb(fixture.home)

    // The printed URL is a one-shot browser-auth entry: following it sets the
    // session cookie and serves the boot HTML the real browser would load.
    const authenticated = await authenticateWeb(server.url)
    assert.match(authenticated.html, /dsh-session-butler\/client\.js/, 'the Client bundle was not injected into the Web bootstrap')

    const status = await callBridge(server.origin, authenticated.cookie, 'status')
    assert.equal(status.status, 200)
    assert.equal(status.body.ok, true, JSON.stringify(status.body))
    const value = status.body.value
    assert.equal(value.version, PACKAGE_JSON.version)
    assert.equal(value.bridge.mounted, true)
    assert.equal(value.backends.workspaceRegistry, true)
    assert.equal(value.backends.sessionQuery, true)
    assert.equal(value.backends.tools, true)
    assert.equal(value.backends.commands, true)
  } finally {
    await server?.stop()
    await fixture.cleanup()
  }
})

test('the real Host exposes the permanent delete route without a trash detour', { timeout: 120_000 }, async () => {
  const fixture = await createDshHome()
  let server
  try {
    server = await startDshWeb(fixture.home)
    const authenticated = await authenticateWeb(server.url)

    const missing = await callBridge(server.origin, authenticated.cookie, 'delete', {
      sessionId: 'session-00000000-0000-4000-8000-000000000000',
    })
    assert.equal(missing.status, 200)
    assert.equal(missing.body.ok, false)
    assert.equal(missing.body.error?.code, 'session-not-found')

    const list = await callBridge(server.origin, authenticated.cookie, 'list', {
      includeArchived: true,
      archivedOnly: true,
      includeSubagents: false,
      limit: 10,
    })
    assert.equal(list.body.ok, true)
    assert.equal(list.body.value.total, 0)
  } finally {
    await server?.stop()
    await fixture.cleanup()
  }
})
