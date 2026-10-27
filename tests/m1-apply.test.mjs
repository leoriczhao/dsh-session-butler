import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { SessionButlerService } from '../lib/host/service.js'

/** Fake Host context exposing exactly the services `apply` probes. */
function fakeHost({ home, headers }) {
  const provided = new Map()
  const commands = []
  const effects = []
  const ctx = {
    get(name) {
      switch (name) {
        case 'dshHomePath':
          return (...segments) => path.join(home, ...segments)
        case 'sessionQuery':
          return {
            async observeSession(id) {
              if (headers[id] === undefined) {
                const error = new Error('not found')
                error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
                throw error
              }
              return { header: headers[id] }
            },
            async traceSession(id) {
              return { target: { header: headers[id] }, ancestors: [], descendants: [], complete: true }
            },
          }
        case 'sessionPersistence':
          return { async open() { return { async close() {} } }, async stat() { return {} } }
        case 'sessions':
          return { get: () => undefined }
        case 'agents':
          return { get: () => undefined }
        case 'commands':
          return { register(definition) { commands.push(definition); return () => {} } }
        default:
          return undefined
      }
    },
    provide(name, value) {
      provided.set(name, value)
      return () => {}
    },
    effect(execute) {
      effects.push(execute)
      return execute()
    },
  }
  return { ctx, provided, commands, effects }
}

test('apply exposes the trash service and registers /session-butler', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'butler-apply-'))
  try {
    await mkdir(path.join(home, 'sessions', '--proj--', 'session-a'), { recursive: true })
    await writeFile(path.join(home, 'sessions', '--proj--', 'session-a', 'session.v4.jsonl.zstd'), 'dummy')
    const headers = { 'session-a': { id: 'session-a', createdAt: 1, isSeeded: false } }
    const fake = fakeHost({ home, headers })

    apply(fake.ctx, { trashRetentionDays: 30, cascadeSubagents: true, permanentDelete: 'disabled' })

    const service = fake.provided.get('sessionButler')
    assert.ok(service instanceof SessionButlerService)
    assert.equal(fake.effects.length, 1)
    assert.equal(fake.commands.length, 1)
    assert.equal(fake.commands[0].name, 'session-butler')

    const listed = await fake.commands[0].handler({ rawInput: 'list', agent: { session: { id: 'session-current' } } })
    assert.equal(listed.kind, 'success')
    assert.match(listed.text, /empty/)

    const trashed = await fake.commands[0].handler({ rawInput: 'trash session-a', agent: { session: { id: 'session-current' } } })
    assert.equal(trashed.kind, 'success')
    assert.match(trashed.text, /session-a/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
