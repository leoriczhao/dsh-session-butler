import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SessionButlerService } from '../lib/host/service.js'

async function fixture({ native = true, coordinator = true, busy = false, prepareFailure, commitFailure, cleanupFailure } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'butler-native-'))
  const sessionsRoot = path.join(home, 'sessions')
  const headers = {
    root: { id: 'root', createdAt: 1, cwd: home },
    child: { id: 'child', createdAt: 2, cwd: home, origin: 'subagent', parentSession: 'root' },
  }
  const present = new Set(Object.keys(headers))
  const live = new Set(['root'])
  const held = new Set()
  const events = []
  for (const id of present) {
    await mkdir(path.join(sessionsRoot, 'project', id), { recursive: true })
    await writeFile(path.join(sessionsRoot, 'project', id, 'session.v4.jsonl.zstd'), id)
  }
  const persistence = {
    async stat(id) { return present.has(id) ? { header: headers[id], formatStatus: 'current' } : undefined },
    async list() { return [...present].map(id => ({ header: headers[id], formatStatus: 'current' })) },
    async open() { throw new Error('native deletion must not use a legacy writer probe') },
    ...(native ? {
      async prepareDelete(id) {
        events.push(['prepare', id])
        if (prepareFailure === id) {
          const error = new Error('writer held')
          error.name = 'SessionAlreadyOwnedError'
          throw error
        }
        held.add(id)
        let committed = false
        return {
          header: headers[id], operationId: 'delete-' + id,
          get committed() { return committed },
          async commit() {
            assert.ok(held.has(id))
            events.push(['commit', id])
            if (commitFailure === id) throw new Error('storage failed before commit')
            await rm(path.join(sessionsRoot, 'project', id), { recursive: true })
            present.delete(id)
            committed = true
            if (cleanupFailure === id) {
              const error = new Error('cleanup failed after commit')
              error.committed = true
              error.sessionId = id
              error.operationId = 'delete-' + id
              throw error
            }
            return { committed: true, sessionId: id, operationId: 'delete-' + id }
          },
          async close() { events.push(['close', id]); held.delete(id) },
        }
      },
    } : {}),
  }
  const owner = {
    async withIdleSessionsReleased(ids, operation) {
      events.push(['fence', [...ids]])
      if (busy) {
        const error = new Error('pending input')
        error.code = 'SESSION_RELEASE_BUSY'
        error.sessionId = 'root'
        error.reason = 'pending-input'
        throw error
      }
      for (const id of ids) live.delete(id)
      try { return await operation() } finally {
        assert.equal(held.size, 0, 'backend locks close before activation fence releases')
        events.push(['unfence'])
      }
    },
  }
  const service = new SessionButlerService({
    sessionsRoot,
    trashRoot: path.join(home, 'trash'),
    persistence,
    query: {
      async traceSession(id) {
        return {
          target: { header: headers[id], persisted: true, live: live.has(id) },
          ancestors: [], complete: true,
          descendants: id === 'root' && present.has('child')
            ? [{ session: { header: headers.child, persisted: true, live: false }, descendants: [] }]
            : [],
        }
      },
    },
    sessions: { get: id => live.has(id) ? { id } : undefined },
    agents: { get: id => live.has(id) ? { status: 'idle' } : undefined },
    ...(coordinator ? { deletionCoordinator: owner } : {}),
    workspace: {
      async unarchiveSession(id) { assert.ok(held.has(id)); events.push(['unarchive', id]) },
      async unpinSession(id) { assert.ok(held.has(id)); events.push(['unpin', id]) },
      async archiveSession() { throw new Error('must not archive to delete') },
      async pinSession() { throw new Error('must not pin to delete') },
    },
    retentionDays: 30, cascadeSubagents: true, permanentDelete: 'disabled', liveSettleTimeoutMs: 0,
  })
  return { home, service, persistence, live, held, present, events, cleanup: () => rm(home, { recursive: true, force: true }) }
}

test('native deletion releases the owner, prepares all locks and commits leaves first', async () => {
  const f = await fixture()
  try {
    const result = await f.service.delete('root')
    assert.deepEqual(new Set(result.deleted), new Set(['root', 'child']))
    assert.equal(f.present.size, 0)
    assert.deepEqual(f.events.filter(e => e[0] === 'prepare'), [['prepare', 'child'], ['prepare', 'root']])
    assert.deepEqual(f.events.filter(e => e[0] === 'commit'), [['commit', 'child'], ['commit', 'root']])
    assert.equal(f.events.at(-1)[0], 'unfence')
  } finally { await f.cleanup() }
})

test('native preparation failure closes earlier locks without deleting files', async () => {
  const f = await fixture({ prepareFailure: 'root' })
  try {
    await assert.rejects(() => f.service.delete('root'), error => error.code === 'session-locked')
    assert.equal(f.present.size, 2)
    assert.equal(f.held.size, 0)
    assert.ok(!f.events.some(e => e[0] === 'commit'))
  } finally { await f.cleanup() }
})

test('a busy owner rejects deletion without entering storage', async () => {
  const f = await fixture({ busy: true })
  try {
    await assert.rejects(() => f.service.delete('root'), error => error.code === 'session-busy')
    assert.equal(f.present.size, 2)
    assert.ok(!f.events.some(e => e[0] === 'prepare'))
  } finally { await f.cleanup() }
})

test('a loaded session with no owner-release capability remains protected', async () => {
  const f = await fixture({ coordinator: false })
  try {
    await assert.rejects(() => f.service.delete('root'), error => error.code === 'session-in-use')
    assert.equal(f.present.size, 2)
    assert.ok(!f.events.some(e => e[0] === 'prepare'))
  } finally { await f.cleanup() }
})

test('a legacy backend does not release an owner it cannot delete natively', async () => {
  const f = await fixture({ native: false })
  try {
    await assert.rejects(() => f.service.delete('root'), error => error.code === 'session-in-use')
    assert.equal(f.present.size, 2)
    assert.ok(!f.events.some(e => e[0] === 'fence'))
  } finally { await f.cleanup() }
})

test('a later native commit failure reports earlier committed descendants', async () => {
  const f = await fixture({ commitFailure: 'root' })
  try {
    await assert.rejects(() => f.service.delete('root'), error =>
      error.code === 'delete-partial' && error.details.deletedIds.includes('child'))
    assert.equal(f.present.has('root'), true)
    assert.equal(f.present.has('child'), false)
    assert.equal(f.held.size, 0)
  } finally { await f.cleanup() }
})

test('a committed cleanup failure remains a partial result and releases locks', async () => {
  const f = await fixture({ cleanupFailure: 'root' })
  try {
    await assert.rejects(() => f.service.delete('root'), error =>
      error.code === 'delete-partial' && error.details.deletedIds.includes('root'))
    assert.equal(f.present.size, 0)
    assert.equal(f.held.size, 0)
  } finally { await f.cleanup() }
})

test('native batch results include IDs committed before a later failure', async () => {
  const f = await fixture({ commitFailure: 'root' })
  try {
    const result = await f.service.deleteMany(['root'])
    assert.deepEqual(result.failed, ['root'])
    assert.deepEqual(result.moved, ['child'])
    assert.deepEqual(result.items[0].moved, ['child'])
  } finally { await f.cleanup() }
})
