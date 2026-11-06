import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SessionButlerService } from '../lib/host/service.js'
import { ButlerError } from '../lib/shared/errors.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'butler-m1-'))
  const sessionsRoot = path.join(home, 'sessions')
  const trashRoot = path.join(home, 'session-butler', 'trash')
  await mkdir(sessionsRoot, { recursive: true })
  return {
    home,
    sessionsRoot,
    trashRoot,
    pendingRoot: path.join(home, 'session-butler', 'pending'),
    cleanup: () => rm(home, { recursive: true, force: true }),
  }
}

async function addSession(sessionsRoot, project, id) {
  const directory = path.join(sessionsRoot, project, id)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'session.v4.jsonl.zstd'), `dummy:${id}`)
  return directory
}

function header(id, overrides = {}) {
  return { id, createdAt: NOW - 1000, isSeeded: false, ...overrides }
}

function record(value, formatStatus) {
  return {
    header: value,
    live: false,
    persisted: true,
    ...(formatStatus === undefined ? {} : { formatStatus }),
  }
}

/** Build a service over fakes; every port is a plain object exercising the structural contract. */
function makeService({ sessionsRoot, trashRoot, headers, descendants = {}, formatStatus = {}, locked = [], live = new Set(), liveAgents = new Map(), workspace, now = () => NOW, permanentDelete = 'confirm', cascadeSubagents = true, retentionDays = 30, liveSettleTimeoutMs = 3000 }) {
  const query = {
    async observeSession(id) {
      const found = headers[id]
      if (found === undefined) {
        const error = new Error(`session ${id} not found`)
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      return { header: found }
    },
    async traceSession(id) {
      if (headers[id] === undefined) {
        const error = new Error(`session ${id} not found`)
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      return {
        target: record(headers[id]),
        ancestors: [],
        descendants: (descendants[id] ?? []).map(node =>
          node.session === undefined ? { session: node, descendants: [] } : node),
        complete: true,
      }
    },
  }
  const opened = []
  const persistence = {
    opened,
    async open(id) {
      if (locked.includes(id)) {
        const error = new Error('session already has a writer')
        error.name = 'SessionAlreadyOwnedError'
        throw error
      }
      opened.push(id)
      return { async close() {} }
    },
    async stat(id) {
      const found = headers[id]
      if (found === undefined) return undefined
      const status = formatStatus[id]
      return { header: found, ...(status === undefined ? {} : { formatStatus: status }) }
    },
    async list() {
      return Object.entries(headers).map(([id, value]) => {
        const status = formatStatus[id]
        return { header: value, ...(status === undefined ? {} : { formatStatus: status }) }
      })
    },
  }
  const sessions = { get: id => (live.has(id) ? {} : undefined) }
  const agents = { get: id => liveAgents.get(id) }
  const service = new SessionButlerService({
    sessionsRoot,
    trashRoot,
    query,
    persistence,
    sessions,
    agents,
    ...(workspace === undefined ? {} : { workspace }),
    retentionDays,
    cascadeSubagents,
    permanentDelete,
    liveSettleTimeoutMs,
    now,
  })
  return { service, persistence, workspace }
}

test('trash moves the session directory, writes metadata and restores it', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-a': header('session-a', { cwd: '/work/proj' }) },
    })

    const result = await service.trash('session-a', { currentSessionId: 'session-other' })
    assert.deepEqual(result.trashed, ['session-a'])
    assert.equal((await readdir(path.join(home.sessionsRoot, '--proj--'))).length, 0)
    const trashedFiles = await readdir(path.join(home.trashRoot, '--proj--'))
    assert.deepEqual(trashedFiles.sort(), ['session-a', 'session-a.json'])

    const listing = await service.listTrash()
    assert.equal(listing.entries.length, 1)
    assert.equal(listing.entries[0].id, 'session-a')
    assert.equal(listing.entries[0].expired, false)
    assert.equal(listing.entries[0].headerSnapshot.cwd, '/work/proj')

    const restored = await service.restore('session-a')
    assert.equal(restored.restored, 'session-a')
    assert.equal((await readdir(path.join(home.sessionsRoot, '--proj--'))).length, 1)
    assert.equal((await service.listTrash()).entries.length, 0)
  } finally {
    await home.cleanup()
  }
})

test('cascade selects subagent descendants only, never ordinary forks', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-r')
    await addSession(home.sessionsRoot, '--proj--', 'child-1')
    await addSession(home.sessionsRoot, '--proj--', 'session-fork')
    const headers = {
      'session-r': header('session-r'),
      'child-1': header('child-1', { origin: 'subagent', parentSession: 'session-r', delegationDepth: 1 }),
      'session-fork': header('session-fork', { parentSession: 'session-r', isSeeded: true }),
    }
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers,
      descendants: {
        'session-r': [record(headers['child-1']), record(headers['session-fork'])],
      },
    })

    const result = await service.trash('session-r', { cascade: true })
    assert.deepEqual(result.trashed, ['session-r', 'child-1'])
    const remaining = await readdir(path.join(home.sessionsRoot, '--proj--'))
    assert.deepEqual(remaining, ['session-fork'])

    const listing = await service.listTrash()
    const rootEntry = listing.entries.find(entry => entry.id === 'session-r')
    const childEntry = listing.entries.find(entry => entry.id === 'child-1')
    assert.deepEqual(rootEntry.descendants, ['child-1'])
    assert.equal(childEntry.cascadeOf, 'session-r')
  } finally {
    await home.cleanup()
  }
})

test('cascade keeps ordinary forks and their subagents intact', async () => {
  const home = await makeHome()
  try {
    const ids = ['root', 'child', 'grandchild', 'fork', 'fork-child']
    for (const id of ids) await addSession(home.sessionsRoot, '--proj--', id)
    const headers = {
      root: header('root'),
      child: header('child', { origin: 'subagent', parentSession: 'root' }),
      grandchild: header('grandchild', { origin: 'subagent', parentSession: 'child' }),
      fork: header('fork', { parentSession: 'root', isSeeded: true }),
      'fork-child': header('fork-child', { origin: 'subagent', parentSession: 'fork' }),
    }
    const node = (id, descendants = []) => ({ session: record(headers[id]), descendants })
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers,
      descendants: {
        root: [node('child', [node('grandchild')]), node('fork', [node('fork-child')])],
      },
    })
    const result = await service.delete('root', { cascade: true })
    assert.deepEqual(result.deleted, ['root', 'child', 'grandchild'])
    assert.deepEqual((await readdir(path.join(home.sessionsRoot, '--proj--'))).sort(), ['fork', 'fork-child'])
    assert.equal((await service.listTrash()).entries.length, 0)
  } finally {
    await home.cleanup()
  }
})

test('a live session is refused or waits for its owner to release it', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    const live = new Set(['session-a'])
    const refused = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-a': header('session-a') },
      live,
      liveAgents: new Map([['session-a', { status: 'running' }]]),
      liveSettleTimeoutMs: 1,
    })
    await assert.rejects(
      () => refused.service.trash('session-a'),
      (error) => error instanceof ButlerError && error.code === 'session-running',
    )
    assert.equal((await readdir(path.join(home.sessionsRoot, '--proj--'))).length, 1)

    const calls = []
    const releasingLive = new Set(['session-a'])
    const workspace = {
      async archiveSession(id) { calls.push(['archive', id]) },
      async unarchiveSession(id) { calls.push(['unarchive', id]) },
      async pinSession() { throw new Error('not used') },
      async unpinSession(id) { calls.push(['unpin', id]) },
    }
    const waiting = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-a': header('session-a') },
      live: releasingLive,
      liveSettleTimeoutMs: 1000,
      workspace,
    })
    setTimeout(() => releasingLive.delete('session-a'), 10)
    const result = await waiting.service.trash('session-a')
    assert.deepEqual(result.trashed, ['session-a'])
    assert.ok(!calls.some(call => call[0] === 'archive'))
    assert.ok(calls.some(call => call[0] === 'unarchive' && call[1] === 'session-a'))
    assert.ok(calls.some(call => call[0] === 'unpin' && call[1] === 'session-a'))
  } finally {
    await home.cleanup()
  }
})

test('a loaded idle session is refused without touching its files', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-idle')
    const calls = []
    const workspace = {
      archivedSessionIds: [],
      pinnedSessionIds: ['session-idle'],
      async archiveSession(id) { calls.push(['archive', id]) },
      async unarchiveSession(id) { calls.push(['unarchive', id]) },
      async pinSession(id) { calls.push(['pin', id]) },
      async unpinSession(id) { calls.push(['unpin', id]) },
    }
    const { service, persistence } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-idle': header('session-idle') },
      live: new Set(['session-idle']),
      liveAgents: new Map([['session-idle', { status: 'idle' }]]),
      workspace,
    })
    await assert.rejects(
      () => service.delete('session-idle'),
      error => error instanceof ButlerError && error.code === 'session-in-use',
    )
    // Nothing was stopped, archived, unpinned, opened or moved.
    assert.deepEqual(calls, [])
    assert.deepEqual(persistence.opened, [])
    assert.deepEqual(await readdir(path.join(home.sessionsRoot, '--proj--')), ['session-idle'])
    assert.deepEqual(await readdir(path.join(home.sessionsRoot, '--proj--', 'session-idle')), ['session.v4.jsonl.zstd'])
  } finally {
    await home.cleanup()
  }
})

test('a running session is refused as running without cancelling its turn', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-active')
    const calls = []
    const workspace = {
      archivedSessionIds: [],
      pinnedSessionIds: [],
      async archiveSession(id) { calls.push(['archive', id]) },
      async unarchiveSession(id) { calls.push(['unarchive', id]) },
      async pinSession(id) { calls.push(['pin', id]) },
      async unpinSession(id) { calls.push(['unpin', id]) },
    }
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-active': header('session-active') },
      live: new Set(['session-active']),
      liveAgents: new Map([['session-active', { status: 'running' }]]),
      workspace,
    })
    await assert.rejects(
      () => service.delete('session-active'),
      error => error instanceof ButlerError && error.code === 'session-running',
    )
    assert.deepEqual(calls, [])
    assert.deepEqual(await readdir(path.join(home.sessionsRoot, '--proj--')), ['session-active'])
  } finally {
    await home.cleanup()
  }
})

test('a refused delete keeps the archived and pinned flags and the listed row', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-archived')
    const calls = []
    const workspace = {
      archivedSessionIds: ['session-archived'],
      pinnedSessionIds: ['session-archived'],
      async archiveSession(id) { calls.push(['archive', id]) },
      async unarchiveSession(id) { calls.push(['unarchive', id]) },
      async pinSession(id) { calls.push(['pin', id]) },
      async unpinSession(id) { calls.push(['unpin', id]) },
    }
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-archived': header('session-archived') },
      live: new Set(['session-archived']),
      workspace,
    })
    await assert.rejects(
      () => service.delete('session-archived'),
      error => error instanceof ButlerError && error.code === 'session-in-use',
    )
    assert.deepEqual(calls, [])
    const listed = await service.listSessions({ limit: 10, includeArchived: true })
    assert.deepEqual(listed.sessions.map(entry => entry.id), ['session-archived'])
    assert.equal(listed.sessions[0].archived, true)
    assert.equal(listed.sessions[0].pinned, true)
  } finally {
    await home.cleanup()
  }
})

test('write-lease failure and migration-required state abort before moving', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-locked')
    await addSession(home.sessionsRoot, '--proj--', 'session-migrate')

    const locked = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-locked': header('session-locked') },
      locked: ['session-locked'],
    })
    await assert.rejects(
      () => locked.service.trash('session-locked'),
      (error) => error instanceof ButlerError && error.code === 'session-locked',
    )

    const migrating = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-migrate': header('session-migrate') },
      formatStatus: { 'session-migrate': 'migration-required' },
    })
    await assert.rejects(
      () => migrating.service.trash('session-migrate'),
      (error) => error instanceof ButlerError && error.code === 'session-migration-required',
    )

    assert.equal((await readdir(path.join(home.sessionsRoot, '--proj--'))).length, 2)
    assert.equal((await readdir(home.sessionsRoot)).length, 1)
  } finally {
    await home.cleanup()
  }
})

test('unexpected write-probe errors are not reported as another writer', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    const { service, persistence } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-a': header('session-a') },
    })
    persistence.open = async () => { throw new Error('permission denied') }
    await assert.rejects(() => service.delete('session-a'),
      error => error instanceof ButlerError && error.code === 'internal')
    persistence.open = async () => ({ close: async () => { throw new Error('close failed') } })
    await assert.rejects(() => service.delete('session-a'),
      error => error instanceof ButlerError && error.code === 'internal')
    assert.deepEqual(await readdir(path.join(home.sessionsRoot, '--proj--')), ['session-a'])
  } finally {
    await home.cleanup()
  }
})

test('purge requires the config gate and the exact id, then removes the entry', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    const headers = { 'session-a': header('session-a') }
    const disabled = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers,
      permanentDelete: 'disabled',
    })
    await disabled.service.trash('session-a')
    await assert.rejects(
      () => disabled.service.purge('session-a', 'session-a'),
      (error) => error instanceof ButlerError && error.code === 'permanent-delete-disabled',
    )

    const enabled = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers,
      permanentDelete: 'confirm',
    })
    await assert.rejects(
      () => enabled.service.purge('session-a', 'session-b'),
      (error) => error instanceof ButlerError && error.code === 'confirm-mismatch',
    )
    await enabled.service.purge('session-a', 'session-a')
    assert.equal((await enabled.service.listTrash()).entries.length, 0)
    assert.equal((await readdir(path.join(home.trashRoot, '--proj--')).catch(() => [])).length, 0)
  } finally {
    await home.cleanup()
  }
})

test('delete removes the session permanently without leaving a trash entry', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-a': header('session-a') },
      permanentDelete: 'disabled',
    })

    const result = await service.delete('session-a', { currentSessionId: 'session-other' })
    assert.deepEqual(result.deleted, ['session-a'])
    assert.equal((await readdir(path.join(home.sessionsRoot, '--proj--'))).length, 0)
    assert.equal((await service.listTrash()).entries.length, 0)
  } finally {
    await home.cleanup()
  }
})

test('delete cascades subagent descendants and deleteMany reports per-item outcomes', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    await addSession(home.sessionsRoot, '--proj--', 'session-child')
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: {
        'session-a': header('session-a'),
        'session-child': header('session-child', { origin: 'subagent' }),
      },
      descendants: { 'session-a': [{ header: header('session-child', { origin: 'subagent' }), live: false, persisted: true }] },
    })

    const result = await service.delete('session-a')
    assert.deepEqual([...result.deleted].sort(), ['session-a', 'session-child'])
    assert.equal((await readdir(path.join(home.sessionsRoot, '--proj--'))).length, 0)
    assert.equal((await service.listTrash()).entries.length, 0)

    const batch = await service.deleteMany(['session-missing'])
    assert.equal(batch.items.length, 1)
    assert.equal(batch.items[0].ok, false)
    assert.deepEqual(batch.failed, ['session-missing'])
  } finally {
    await home.cleanup()
  }
})

test('restore refuses an occupied original path and keeps the trash entry', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-a': header('session-a') },
    })
    await service.trash('session-a')
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    await assert.rejects(
      () => service.restore('session-a'),
      (error) => error instanceof ButlerError && error.code === 'trash-conflict',
    )
    assert.equal((await service.listTrash()).entries.length, 1)
  } finally {
    await home.cleanup()
  }
})

test('retention marks entries expired without auto-purging them', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-a': header('session-a') },
      retentionDays: 30,
      now: () => NOW - 31 * DAY,
    })
    await service.trash('session-a')

    const later = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-a': header('session-a') },
      retentionDays: 30,
      now: () => NOW,
    })
    const listing = await later.service.listTrash()
    assert.equal(listing.entries.length, 1)
    assert.equal(listing.entries[0].expired, true)
    assert.equal(listing.entries[0].expiresAt, NOW - DAY)
  } finally {
    await home.cleanup()
  }
})

test('refuses to trash the current session and reports orphans without failing', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    const { service } = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-a': header('session-a') },
    })
    await assert.rejects(
      () => service.trash('session-a', { currentSessionId: 'session-a' }),
      (error) => error instanceof ButlerError && error.code === 'cannot-trash-current',
    )
    await mkdir(path.join(home.trashRoot, '--proj--', 'session-orphan'), { recursive: true })
    const listing = await service.listTrash()
    assert.equal(listing.entries.length, 0)
    assert.equal(listing.orphans, 1)
  } finally {
    await home.cleanup()
  }
})