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
function makeService({ sessionsRoot, trashRoot, headers, descendants = {}, formatStatus = {}, locked = [], live = new Set(), workspace, now = () => NOW, permanentDelete = 'confirm', cascadeSubagents = true, retentionDays = 30 }) {
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
        descendants: (descendants[id] ?? []).map(node => ({ session: node, descendants: [] })),
        complete: true,
      }
    },
  }
  const opened = []
  const persistence = {
    opened,
    async open(id) {
      if (locked.includes(id)) throw new Error('writer held')
      opened.push(id)
      return { async close() {} }
    },
    async stat(id) {
      const status = formatStatus[id]
      return status === undefined ? {} : { formatStatus: status }
    },
  }
  const sessions = { get: id => (live.has(id) ? {} : undefined) }
  const agents = { get: () => undefined }
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

test('running sessions are refused without a workspace service, and stopped with one', async () => {
  const home = await makeHome()
  try {
    await addSession(home.sessionsRoot, '--proj--', 'session-a')
    const live = new Set(['session-a'])
    const refused = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-a': header('session-a') },
      live,
    })
    await assert.rejects(
      () => refused.service.trash('session-a'),
      (error) => error instanceof ButlerError && error.code === 'session-running',
    )
    assert.equal((await readdir(path.join(home.sessionsRoot, '--proj--'))).length, 1)

    const calls = []
    const stoppingLive = new Set(['session-a'])
    const workspace = {
      async archiveSession(id, options) { calls.push(['archive', id, options]); stoppingLive.delete(id) },
      async unarchiveSession(id) { calls.push(['unarchive', id]) },
      async pinSession() { throw new Error('not used') },
      async unpinSession(id) { calls.push(['unpin', id]) },
    }
    const stopping = makeService({
      sessionsRoot: home.sessionsRoot,
      trashRoot: home.trashRoot,
      headers: { 'session-a': header('session-a') },
      live: stoppingLive,
      workspace,
    })
    const result = await stopping.service.trash('session-a')
    assert.deepEqual(result.trashed, ['session-a'])
    assert.deepEqual(calls[0], ['archive', 'session-a', { stopActivity: true }])
    assert.ok(calls.some(call => call[0] === 'unarchive' && call[1] === 'session-a'))
    assert.ok(calls.some(call => call[0] === 'unpin' && call[1] === 'session-a'))
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
