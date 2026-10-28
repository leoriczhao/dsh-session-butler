import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDetailTool,
  createListTool,
  registerButlerTools,
} from '../lib/host/tools.js'

function makeReadModel({ sessions = [], detail } = {}) {
  const calls = []
  return {
    calls,
    async listSessions(filters) {
      calls.push(['list', filters])
      return {
        sessions,
        total: sessions.length,
        truncated: false,
      }
    },
    async detail(sessionId) {
      calls.push(['detail', sessionId])
      if (detail === undefined) throw new Error(`unexpected detail ${sessionId}`)
      return detail
    },
  }
}

test('registerButlerTools registers both read-only tools and disposes them', () => {
  const registered = []
  const disposed = []
  const tools = {
    register(definition) {
      registered.push(definition)
      const id = registered.length
      return () => disposed.push(id)
    },
  }
  const dispose = registerButlerTools(tools, makeReadModel())
  assert.deepEqual(registered.map(tool => tool.name), ['session_butler_list', 'session_butler_detail'])
  assert.equal(typeof registered[0].execute, 'function')
  assert.equal(typeof registered[0].output.render, 'function')
  assert.match(registered[0].description, /Read-only/)
  assert.match(registered[1].description, /Read-only/)
  assert.equal(registered[0].parameters.type, 'object')
  assert.equal(registered[1].parameters.type, 'object')
  assert.deepEqual(registered[1].parameters.required, ['sessionId'])
  assert.equal(registered[1].parameters.properties.sessionId.type, 'string')
  assert.match(registered[1].parameters.properties.sessionId.description, /Exact session id/)
  assert.equal(registered[0].parameters.required, undefined)
  assert.equal(registered[0].output.schema.type, 'object')
  assert.equal(registered[0].output.schema.additionalProperties, false)
  dispose()
  assert.deepEqual(disposed.sort(), [1, 2])
})

test('session_butler_list forwards filters, bounds the limit, and renders rows with flags', async () => {
  const sessions = [
    {
      id: 'session-new',
      createdAt: Date.now() - 90 * 60 * 1000,
      cwd: '/work/proj',
      title: 'Release checklist',
      archived: false,
      pinned: true,
      subagent: false,
      live: false,
    },
    {
      id: 'session-child',
      createdAt: Date.now() - 30 * 60 * 1000,
      cwd: '/work/proj',
      archived: true,
      pinned: false,
      subagent: true,
      parentSession: 'session-new',
      formatStatus: 'migration-required',
      live: true,
    },
  ]
  const read = makeReadModel({ sessions })
  const tool = createListTool(read)

  const value = await tool.execute(
    { query: ' release ', cwd: '/work/proj', includeArchived: true, limit: 250 },
    {},
  )
  assert.deepEqual(read.calls, [['list', {
    query: 'release',
    cwd: '/work/proj',
    includeArchived: true,
    limit: 100,
  }]])
  assert.equal(value.sessions.length, 2)

  const rendered = tool.output.render({}, value)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  const lines = rendered[0].text.split('\n')
  assert.match(lines[0], /^session-new {2}Release checklist {2}\/work\/proj {2}1h ago {2}\[pinned\]$/)
  assert.match(lines[1], /session-child {2}\(untitled\) {2}\/work\/proj {2}30m ago {2}\[live, archived, subagent, migration-required\]$/)

  const empty = tool.output.render({}, { sessions: [], total: 0, truncated: false })
  assert.equal(empty[0].text, '(no sessions)')

  const truncated = tool.output.render({ limit: 2 }, { sessions, total: 9, truncated: true })
  assert.match(truncated[0].text, /\(showing 2 of 9; limit 2\)$/)
})

test('session_butler_detail delegates by exact id and renders figures and flat lineage', async () => {
  const created = Date.now() - 24 * 60 * 60 * 1000
  const detail = {
    id: 'session-root',
    headerSnapshot: { id: 'session-root', cwd: '/work/proj', createdAt: created, agentPreset: 'build' },
    live: false,
    descendantIds: ['session-child'],
    enrichment: { status: 'complete' },
    stats: {
      turns: 2,
      steps: 3,
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 4,
      toolResults: 4,
      tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      sizeBytes: 4096,
      eventCount: 20,
      title: 'Fix the thing',
    },
    lineage: {
      complete: false,
      missingParentId: 'session-gone',
      ancestors: [{ id: 'session-parent', cwd: '/work/proj' }],
      descendants: [{
        id: 'session-child',
        parentSession: 'session-root',
        origin: 'subagent',
        descendants: [{ id: 'session-grandchild', origin: 'subagent', descendants: [] }],
      }],
    },
  }
  const read = makeReadModel({ detail })
  const tool = createDetailTool(read)

  const value = await tool.execute({ sessionId: 'session-root' }, {})
  assert.deepEqual(read.calls, [['detail', 'session-root']])
  assert.equal(value.id, 'session-root')
  assert.deepEqual(value.lineage.ancestors, [{ id: 'session-parent', cwd: '/work/proj' }])
  assert.deepEqual(value.lineage.descendants, [
    { id: 'session-child', parent: 'session-root', depth: 1, origin: 'subagent' },
    { id: 'session-grandchild', parent: 'session-child', depth: 2, origin: 'subagent' },
  ])
  assert.equal(value.lineage.missingParentId, 'session-gone')

  const text = tool.output.render({}, value)[0].text
  assert.match(text, /^session-root {2}Fix the thing$/m)
  assert.match(text, /cwd=\/work\/proj {2}created=/)
  assert.match(text, /turns=2 {2}steps=3/)
  assert.match(text, /tokens: input=100 output=50 cacheRead=10 cacheWrite=5/)
  assert.match(text, /size=4\.0 KB {2}events=20/)
  assert.match(text, /lineage: session-parent -> session-root \(missing session-gone\)/)
  assert.match(text, /descendants:\n {2}session-child \[subagent\]\n {4}session-grandchild \[subagent\]/)

  await assert.rejects(tool.execute({}, {}), /sessionId is required/)
})

test('session_butler_detail renders partial enrichment and omits absent figures', async () => {
  const detail = {
    id: 'session-old',
    headerSnapshot: { id: 'session-old', createdAt: Date.now() },
    formatStatus: 'migration-required',
    live: false,
    descendantIds: [],
    enrichment: { status: 'partial', reason: 'migration-required' },
    stats: { eventCount: 12, sizeBytes: 900 },
    lineage: { complete: true, ancestors: [], descendants: [] },
  }
  const read = makeReadModel({ detail })
  const tool = createDetailTool(read)
  const value = await tool.execute({ sessionId: 'session-old' }, {})
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /format=migration-required/)
  assert.match(text, /enrichment: partial \(migration-required\)/)
  assert.doesNotMatch(text, /tokens:/)
  assert.doesNotMatch(text, /lineage:/)
  assert.doesNotMatch(text, /descendants:/)
})

test('registerButlerTools adds session_butler_new only when a session creator is available', async () => {
  const registered = []
  const tools = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  const created = []
  const create = {
    async create(request) {
      created.push(request)
      return { sessionId: 'session-child-new', agentPreset: request.agentPreset }
    },
  }
  registerButlerTools(tools, makeReadModel(), { create })
  assert.deepEqual(registered.map(tool => tool.name), [
    'session_butler_list',
    'session_butler_detail',
    'session_butler_new',
  ])
  const newTool = registered[2]
  assert.equal(newTool.parameters.type, 'object')
  assert.deepEqual(newTool.parameters.properties, {})
  assert.equal(newTool.parameters.required, undefined)
  assert.equal(newTool.output.schema.required.includes('sessionId'), true)

  const value = await newTool.execute({}, {
    agent: { session: { id: 'session-caller', header: { id: 'session-caller', cwd: '/work/proj', agentPreset: 'build' } } },
  })
  assert.deepEqual(created, [{ cwd: '/work/proj', agentPreset: 'build' }])
  assert.deepEqual(value, {
    sessionId: 'session-child-new',
    cwd: '/work/proj',
    agentPreset: 'build',
  })
  const rendered = newTool.output.render({}, value)
  assert.equal(rendered[0].text, 'created session-child-new in /work/proj (preset: build)')

  await assert.rejects(
    () => newTool.execute({}, {}),
    /needs the caller session working directory/,
  )
  await assert.rejects(
    () => newTool.execute({}, { agent: { session: { header: { id: 'session-caller' } } } }),
    /needs the caller session working directory/,
  )
})

test('registerButlerTools adds session_butler_fork only when a session forker is available', async () => {
  const registered = []
  const tools = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  const forked = []
  const fork = {
    async fork(request) {
      forked.push(request)
      return { sessionId: 'session-child-fork' }
    },
  }
  registerButlerTools(tools, makeReadModel(), { fork })
  assert.deepEqual(registered.map(tool => tool.name), [
    'session_butler_list',
    'session_butler_detail',
    'session_butler_fork',
  ])
  const forkTool = registered[2]
  assert.equal(forkTool.parameters.type, 'object')
  assert.equal(forkTool.parameters.properties.atSeq.type, 'integer')
  assert.equal(forkTool.parameters.required, undefined)
  assert.equal(forkTool.output.schema.required.includes('sessionId'), true)
  assert.equal(forkTool.output.schema.required.includes('sourceSessionId'), true)

  const value = await forkTool.execute({}, {
    agent: { session: { id: 'session-caller', header: { id: 'session-caller', cwd: '/work/proj' } } },
  })
  assert.deepEqual(forked, [{ sessionId: 'session-caller' }])
  assert.deepEqual(value, { sessionId: 'session-child-fork', sourceSessionId: 'session-caller' })
  assert.equal(
    forkTool.output.render({}, value)[0].text,
    'forked session-caller at the latest completed turn → session-child-fork',
  )

  const withSeq = await forkTool.execute({ atSeq: 12 }, {
    agent: { session: { id: 'session-caller', header: { id: 'session-caller' } } },
  })
  assert.deepEqual(forked.at(-1), { sessionId: 'session-caller', atSeq: 12 })
  assert.deepEqual(withSeq, { sessionId: 'session-child-fork', sourceSessionId: 'session-caller', atSeq: 12 })
  assert.equal(
    forkTool.output.render({ atSeq: 12 }, withSeq)[0].text,
    'forked session-caller at event 12 → session-child-fork',
  )

  await assert.rejects(
    () => forkTool.execute({ atSeq: -1 }, { agent: { session: { id: 'session-caller' } } }),
    /non-negative safe integer/,
  )
  await assert.rejects(
    () => forkTool.execute({}, {}),
    /needs the caller session/,
  )
})

test('registerButlerTools advertises both creation tools when the composition supports them', () => {
  const registered = []
  const tools = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  registerButlerTools(tools, makeReadModel(), {
    create: { async create(request) { return { sessionId: 'session-new', ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) } } },
    fork: { async fork() { return { sessionId: 'session-fork' } } },
  })
  assert.deepEqual(registered.map(tool => tool.name), [
    'session_butler_list',
    'session_butler_detail',
    'session_butler_new',
    'session_butler_fork',
  ])
})
