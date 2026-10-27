import assert from 'node:assert/strict'
import test from 'node:test'

const host = await import(new URL('../lib/index.js', import.meta.url))

test('host entry exports a Cordis plugin identity', () => {
  assert.equal(host.name, 'dsh-session-butler')
  assert.equal(typeof host.apply, 'function')
  assert.ok(Array.isArray(host.inject))
})

test('host entry exports the stable identifiers used by the Client half', () => {
  assert.equal(host.PLUGIN_ID, 'dsh-session-butler')
  assert.equal(host.PLUGIN_ROW_ID, 'session-butler')
  assert.equal(host.PANEL_ID, 'session-butler')
  assert.equal(host.API_PREFIX, 'session-butler/api')
})

test('config schema resolves the documented safe defaults', () => {
  const config = host.Config({})
  assert.equal(config.trashRetentionDays, 30)
  assert.equal(config.cascadeSubagents, true)
  assert.equal(config.permanentDelete, 'disabled')
})

test('config schema rejects an out-of-range retention', () => {
  assert.throws(() => host.Config({ trashRetentionDays: -1 }))
})
