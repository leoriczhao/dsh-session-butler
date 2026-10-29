import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { SessionButlerService } from '../lib/host/service.js'

/** Fake Host context exposing exactly the services `apply` probes. */
function fakeHost({ home, headers, deferSessionController = false }) {
  const provided = new Map()
  const commands = []
  const effects = []
  const routes = []
  const injections = []
  const tools = []
  const extras = new Map()
  const deferredInjections = []
  const ctx = {
    get(name) {
      if (extras.has(name)) return extras.get(name)
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
          return {
            async open() { return { async close() {} } },
            async stat(id) {
              const found = headers[id]
              return found === undefined ? undefined : { header: found }
            },
            async list() { return Object.values(headers).map(header => ({ header })) },
          }
        case 'sessions':
          return { get: () => undefined }
        case 'agents':
          return { get: () => undefined }
        case 'commands':
          return { register(definition) { commands.push(definition); return () => {} } }
        case 'webServer':
          return { register(route) { routes.push(route); return () => {} } }
        case 'connection':
          return { requestRejection() { return undefined } }
        case 'tools':
          return { register(definition) { tools.push(definition); return () => {} } }
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
    inject(names, callback) {
      injections.push(names)
      if (deferSessionController && names.includes('sessionController')) {
        deferredInjections.push({ names, callback })
        return () => {}
      }
      return callback(this)
    },
  }
  return { ctx, provided, commands, effects, routes, injections, tools, extras, deferredInjections }
}

test('apply binds the creation tools when sessionController mounts after tools', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'butler-apply-late-'))
  try {
    const fake = fakeHost({ home, headers: {}, deferSessionController: true })
    apply(fake.ctx, { trashRetentionDays: 30, cascadeSubagents: true, permanentDelete: 'disabled' })
    assert.deepEqual(fake.tools.map(tool => tool.name), ['session_butler_list', 'session_butler_detail'])

    fake.extras.set('sessionController', {
      async create() { return { sessionId: 'session-new' } },
      async fork() { return { sessionId: 'session-fork', sourceSessionId: 'session-current' } },
    })
    assert.equal(fake.deferredInjections.length, 1)
    for (const deferred of fake.deferredInjections) {
      assert.deepEqual(deferred.names, ['tools', 'sessionController'])
      deferred.callback(fake.ctx)
    }
    assert.deepEqual(fake.tools.map(tool => tool.name), [
      'session_butler_list',
      'session_butler_detail',
      'session_butler_new',
      'session_butler_fork',
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('apply wires the caller Workspace into session_butler_new', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'butler-apply-workspace-'))
  try {
    const fake = fakeHost({ home, headers: {} })
    const created = []
    fake.extras.set('workspaceRegistry', {
      async archiveSession() {},
      async unarchiveSession() {},
      async pinSession() {},
      async unpinSession() {},
      list() {
        return [{ id: 'ws-proj', path: '/work/proj', sessionIds: ['session-caller'] }]
      },
    })
    fake.extras.set('sessionController', {
      async create(request) {
        created.push(request)
        return { sessionId: 'session-new' }
      },
    })

    apply(fake.ctx, { trashRetentionDays: 30, cascadeSubagents: true, permanentDelete: 'disabled' })

    const newTool = fake.tools.find(tool => tool.name === 'session_butler_new')
    assert.ok(newTool, 'session_butler_new is registered while sessionController is present')
    const value = await newTool.execute({}, {
      agent: { session: { id: 'session-caller', header: { id: 'session-caller', cwd: '/work/proj' } } },
    })
    assert.deepEqual(created, [{ workspaceId: 'ws-proj' }])
    assert.deepEqual(value, { sessionId: 'session-new', cwd: '/work/proj' })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

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
    // One effect each for the command, the HTTP bridge, and the read-only tools.
    assert.equal(fake.effects.length, 3)
    assert.equal(fake.commands.length, 1)
    assert.equal(fake.commands[0].name, 'session-butler')
    assert.deepEqual(fake.injections, [['webServer', 'connection'], ['tools'], ['tools', 'sessionController']])
    assert.deepEqual(fake.tools.map(tool => tool.name), ['session_butler_list', 'session_butler_detail'])
    assert.equal(fake.routes.length, 1)
    assert.equal(fake.routes[0].path, '/session-butler/api')
    assert.equal(fake.routes[0].kind, 'prefix')

    const listed = await fake.commands[0].handler({ rawInput: 'list', agent: { session: { id: 'session-current' } } })
    assert.equal(listed.kind, 'success')
    assert.match(listed.text, /empty/)

    const trashed = await fake.commands[0].handler({ rawInput: 'trash session-a', agent: { session: { id: 'session-current' } } })
    assert.equal(trashed.kind, 'success', trashed.text)
    assert.match(trashed.text, /session-a/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
