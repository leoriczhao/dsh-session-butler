import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SessionButlerService } from '../lib/host/service.js'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'butler-m3-'))
  const sessionsRoot = path.join(home, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  return {
    home,
    sessionsRoot,
    trashRoot: path.join(home, 'session-butler', 'trash'),
    cleanup: () => rm(home, { recursive: true, force: true }),
  }
}

async function addSession(sessionsRoot, project, id) {
  const directory = path.join(sessionsRoot, project, id)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'session.v4.jsonl.zstd'), `dummy:${id}`)
}

function header(id, overrides = {}) {
  return { id, createdAt: NOW - DAY, isSeeded: false, ...overrides }
}

/**
 * Build a service over fake Host services.
 * `events[id]` supplies the observation log; omitted entries observe an empty log.
 */
function makeService({
  sessionsRoot,
  trashRoot,
  headers,
  events = {},
  descendants = {},
  formatStatus = {},
  titles = {},
  sessions = [],
  archived = [],
  pinned = [],
  observed = [],
  failedObservations = new Set(),
  statEventCount = true,
}) {
  const observedCalls = observed
  const query = {
    async observeSession(id, options) {
      observedCalls.push([id, options])
      if (failedObservations.has(id)) throw new Error('log unreadable')
      const found = headers[id]
      if (found === undefined) {
        const error = new Error(`session ${id} not found`)
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      return {
        header: found,
        inheritedEventCount: fromEvents(events[id]).length,
        cursor: fromEvents(events[id]).length - 1,
        events: events[id] ?? [],
      }
    },
    async traceSession(id) {
      if (headers[id] === undefined) {
        const error = new Error(`session ${id} not found`)
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      return {
        target: { header: headers[id], live: false, persisted: true },
        ancestors: (Array.isArray(descendants) ? [] : (descendants[id]?.ancestors ?? [])).map(value => ({ header: value, live: false, persisted: true })),
        descendants: (descendants[id]?.children ?? []).map(node => ({
          session: { header: node.header, live: false, persisted: true },
          descendants: (node.descendants ?? []).map(child => ({
            session: { header: child, live: false, persisted: true },
            descendants: [],
          })),
        })),
        complete: true,
      }
    },
    async readTitleSnapshots(ids) {
      return ids.map(id => titles[id] === undefined
        ? { sessionId: id, status: 'rejected', reason: new Error('no title') }
        : { sessionId: id, status: 'fulfilled', value: { session: headers[id], title: { title: titles[id], updatedAt: NOW } } })
    },
  }
  const persistence = {
    async open() { return { async close() {} } },
    async stat(id) {
      const found = headers[id]
      if (found === undefined) return undefined
      const status = formatStatus[id]
      return {
        header: found,
        ...(status === undefined ? {} : { formatStatus: status }),
        ...(statEventCount ? { eventCount: fromEvents(events[id]).length } : {}),
        sizeBytes: 2048,
      }
    },
    async list() {
      return Object.values(headers).map((value) => {
        const status = formatStatus[value.id]
        return { header: value, ...(status === undefined ? {} : { formatStatus: status }) }
      })
    },
  }
  const sessionsPort = {
    get: id => sessions.find(value => value.header?.id === id),
    list: () => sessions,
  }
  const agents = { get: () => undefined, list: () => [] }
  const workspace = archived.length === 0 && pinned.length === 0
    ? undefined
    : {
        async archiveSession() {},
        async unarchiveSession() {},
        async pinSession() {},
        async unpinSession() {},
        archivedSessionIds: archived,
        pinnedSessionIds: pinned,
      }
  const service = new SessionButlerService({
    sessionsRoot,
    trashRoot,
    query,
    persistence,
    sessions: sessionsPort,
    agents,
    ...(workspace === undefined ? {} : { workspace }),
    retentionDays: 30,
    cascadeSubagents: true,
    permanentDelete: 'confirm',
    now: () => NOW,
  })
  return { service, observedCalls }
}

function fromEvents(events) {
  return Array.isArray(events) ? events : []
}

/** A representative observation log: one closed turn with usage, title, and preset metadata. */
const LOG = [
  { type: 'user/message', seq: 0, time: NOW - 5000, data: { source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 1, time: NOW - 4000, data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } } },
  { type: 'tool/call', seq: 2, time: NOW - 3000 },
  { type: 'tool/result', seq: 3, time: NOW - 2500 },
  { type: 'step/end', seq: 4, time: NOW - 2000 },
  { type: 'turn/end', seq: 5, time: NOW - 1500, data: { turn: 1, reason: 'stop' } },
  { type: 'session/title', seq: 6, time: NOW - 1000, data: { title: 'Fix the thing', messageSeqs: [0], source: 'provider' } },
]

test('detail enriches header, log figures, tokens, title, size, preset and lineage', async () => {
  const home = await makeHome()
  try {
    const root = header('session-root', {
      createdAt: NOW - DAY,
      cwd: '/work/proj',
      agentPreset: 'build',
      parentSession: 'session-parent',
    })
    const parent = header('session-parent', { createdAt: NOW - 2 * DAY, cwd: '/work/proj' })
    const child = header('session-child', { createdAt: NOW - 5000, origin: 'subagent', parentSession: 'session-root' })
    const grandchild = header('session-grandchild', { createdAt: NOW - 4000, origin: 'subagent', parentSession: 'session-child' })
    const { service, observedCalls } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: {
        'session-root': root,
        'session-parent': parent,
        'session-child': child,
        'session-grandchild': grandchild,
      },
      events: { 'session-root': LOG },
      descendants: {
        'session-root': {
          ancestors: [parent],
          children: [{ header: child, descendants: [grandchild] }],
        },
      },
    })

    const detail = await service.detail('session-root')
    assert.equal(detail.enrichment.status, 'complete')
    assert.deepEqual(detail.headerSnapshot, {
      id: 'session-root',
      cwd: '/work/proj',
      createdAt: NOW - DAY,
      parentSession: 'session-parent',
      isSeeded: false,
      agentPreset: 'build',
    })
    assert.deepEqual(detail.stats, {
      turns: 1,
      steps: 1,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 1,
      toolResults: 1,
      lastActivityAt: NOW - 1000,
      title: 'Fix the thing',
      tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
      eventCount: 7,
      sizeBytes: 2048,
      inheritedEventCount: 7,
    })
    assert.deepEqual(detail.descendantIds, ['session-child', 'session-grandchild'])
    assert.equal(detail.lineage.complete, true)
    assert.deepEqual(detail.lineage.ancestors.map(entry => entry.id), ['session-parent'])
    assert.deepEqual(detail.lineage.descendants.map(node => node.id), ['session-child'])
    assert.deepEqual(detail.lineage.descendants[0].descendants.map(node => node.id), ['session-grandchild'])
    // Projection computation is deliberately skipped; the tool derives figures from events.
    assert.deepEqual(observedCalls, [['session-root', { projectionMode: 'none' }]])
  } finally {
    await home.cleanup()
  }
})

test('detail falls back to the observed log length when stat omits eventCount', async () => {
  const home = await makeHome()
  try {
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-live': header('session-live') },
      events: { 'session-live': LOG },
      statEventCount: false,
    })
    const detail = await service.detail('session-live')
    assert.equal(detail.stats.eventCount, 7)
    assert.equal(detail.stats.sizeBytes, 2048)
    assert.equal(detail.stats.turns, 1)
  } finally {
    await home.cleanup()
  }
})

test('detail reports partial enrichment for migration-required and unreadable logs without failing', async () => {
  const home = await makeHome()
  try {
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: {
        'session-old': header('session-old'),
        'session-broken': header('session-broken'),
      },
      formatStatus: { 'session-old': 'migration-required' },
      failedObservations: new Set(['session-broken']),
    })

    const migration = await service.detail('session-old')
    assert.equal(migration.formatStatus, 'migration-required')
    assert.deepEqual(migration.enrichment, { status: 'partial', reason: 'migration-required' })
    assert.equal(migration.stats.eventCount, 0)
    assert.deepEqual(migration.descendantIds, [])

    const broken = await service.detail('session-broken')
    assert.deepEqual(broken.enrichment, { status: 'partial', reason: 'read-failed' })
    assert.equal(broken.stats.sizeBytes, 2048)
    assert.equal(broken.stats.turns, undefined)
  } finally {
    await home.cleanup()
  }
})

test('detail fails with session-not-found for an unknown id', async () => {
  const home = await makeHome()
  try {
    const { service } = makeService({ sessionsRoot: home.sessionsRoot, trashRoot: home.trashRoot, headers: {} })
    await assert.rejects(service.detail('missing'), error => error.code === 'session-not-found')
  } finally {
    await home.cleanup()
  }
})

test('listSessions pages newest-first, joins live rows, titles, archive and pin state', async () => {
  const home = await makeHome()
  try {
    const headers = {
      'session-new': header('session-new', { createdAt: NOW - 1000, cwd: '/work/alpha' }),
      'session-old': header('session-old', { createdAt: NOW - 10 * DAY, cwd: '/work/beta' }),
      'session-child': header('session-child', { createdAt: NOW - 500, cwd: '/work/alpha', origin: 'subagent', parentSession: 'session-new' }),
      'session-archived': header('session-archived', { createdAt: NOW - 2000, cwd: '/work/alpha' }),
      'session-live-only': header('session-live-only', { createdAt: NOW - 3000, cwd: '/work/alpha' }),
    }
    const liveSession = { header: headers['session-live-only'] }
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: {
        'session-new': headers['session-new'],
        'session-old': headers['session-old'],
        'session-child': headers['session-child'],
        'session-archived': headers['session-archived'],
      },
      titles: { 'session-new': 'Release checklist' },
      sessions: [liveSession],
      archived: ['session-archived'],
      pinned: ['session-old'],
    })

    const page = await service.listSessions()
    assert.equal(page.total, 4)
    assert.equal(page.truncated, false)
    assert.deepEqual(page.sessions.map(entry => entry.id), [
      'session-child',
      'session-new',
      'session-live-only',
      'session-old',
    ])
    const newest = page.sessions[1]
    assert.equal(newest.title, 'Release checklist')
    assert.equal(newest.archived, false)
    assert.equal(newest.pinned, false)
    assert.equal(newest.live, false)
    assert.equal(page.sessions[0].subagent, true)
    const liveOnly = page.sessions[2]
    assert.equal(liveOnly.live, true)
    assert.equal(page.sessions[3].pinned, true)

    const withArchived = await service.listSessions({ includeArchived: true })
    assert.equal(withArchived.total, 5)
    assert.equal(withArchived.sessions.find(entry => entry.id === 'session-archived').archived, true)

    const archivedOnly = await service.listSessions({ archivedOnly: true })
    assert.equal(archivedOnly.total, 1)
    assert.deepEqual(archivedOnly.sessions.map(entry => entry.id), ['session-archived'])

    const withoutSubagents = await service.listSessions({ includeSubagents: false })
    assert.equal(withoutSubagents.total, 3)

    const byCwd = await service.listSessions({ cwd: '/work/alpha' })
    assert.deepEqual(byCwd.sessions.map(entry => entry.id), ['session-child', 'session-new', 'session-live-only'])

    const byQuery = await service.listSessions({ query: 'SESSION-OLD' })
    assert.deepEqual(byQuery.sessions.map(entry => entry.id), ['session-old'])

    const limited = await service.listSessions({ limit: 2 })
    assert.equal(limited.sessions.length, 2)
    assert.equal(limited.truncated, true)
    assert.equal(limited.total, 4)
  } finally {
    await home.cleanup()
  }
})

test('batch trash and restore report per-item outcomes and keep processing after failures', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    await addSession(home.sessionsRoot, '--proj--', 'session-b')
    await addSession(home.sessionsRoot, '--proj--', 'session-child')
    const child = header('session-child', { origin: 'subagent', parentSession: 'session-a' })
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: {
        'session-a': header('session-a'),
        'session-b': header('session-b'),
        'session-child': child,
      },
      descendants: { 'session-a': { children: [{ header: child }] } },
    })

    const trashed = await service.trashMany(['session-a', 'missing', 'session-child', 'session-b'])
    assert.deepEqual(trashed.moved, ['session-a', 'session-child', 'session-b'])
    assert.deepEqual(trashed.failed, ['missing'])
    assert.equal(trashed.items.length, 4)
    assert.equal(trashed.items[0].ok, true)
    assert.deepEqual(trashed.items[0].moved, ['session-a', 'session-child'])
    assert.equal(trashed.items[1].ok, false)
    assert.equal(trashed.items[1].error.code, 'session-not-found')
    // Already removed as part of the first cascade: reported as a no-op success.
    assert.equal(trashed.items[2].ok, true)
    assert.deepEqual(trashed.items[2].moved, [])
    assert.equal(trashed.items[3].ok, true)
    assert.deepEqual(trashed.items[3].moved, ['session-b'])

    const restored = await service.restoreMany(['session-b', 'missing', 'session-a', 'session-child'])
    assert.deepEqual(restored.moved, ['session-b', 'session-a', 'session-child'])
    assert.deepEqual(restored.failed, ['missing'])
    assert.equal(restored.items[1].error.code, 'trash-not-found')
  } finally {
    await home.cleanup()
  }
})

test('batch validation rejects empty, oversized and malformed id lists', async () => {
  const home = await makeHome()
  try {
    const { service } = makeService({ sessionsRoot: home.sessionsRoot, trashRoot: home.trashRoot, headers: {} })
    await assert.rejects(service.trashMany([]), error => error.code === 'invalid-request')
    await assert.rejects(service.restoreMany(['']), error => error.code === 'invalid-request')
    await assert.rejects(service.trashMany([42]), error => error.code === 'invalid-request')
    await assert.rejects(
      service.restoreMany(Array.from({ length: 51 }, (_, index) => `session-${index}`)),
      error => error.code === 'invalid-request',
    )
  } finally {
    await home.cleanup()
  }
})
