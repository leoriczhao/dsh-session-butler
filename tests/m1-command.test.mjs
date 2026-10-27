import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runButlerCommand, createButlerCommand } from '../lib/host/command.js'
import { SessionButlerService } from '../lib/host/service.js'

async function makeService() {
  const home = await mkdtemp(path.join(tmpdir(), 'butler-cmd-'))
  const sessionsRoot = path.join(home, 'sessions')
  await mkdir(path.join(sessionsRoot, '--proj--', 'session-a'), { recursive: true })
  await writeFile(path.join(sessionsRoot, '--proj--', 'session-a', 'session.v4.jsonl.zstd'), 'dummy')
  const headers = { 'session-a': { id: 'session-a', createdAt: 1, isSeeded: false } }
  const service = new SessionButlerService({
    sessionsRoot,
    trashRoot: path.join(home, 'trash'),
    query: {
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
    },
    persistence: { async open() { return { async close() {} } }, async stat() { return {} } },
    retentionDays: 30,
    cascadeSubagents: true,
    permanentDelete: 'confirm',
    now: () => 1_700_000_000_000,
  })
  return { service, cleanup: () => rm(home, { recursive: true, force: true }) }
}

test('command definition exposes the trash surface', () => {
  const definition = createButlerCommand({})
  assert.equal(definition.name, 'session-butler')
  assert.equal(typeof definition.handler, 'function')
  assert.match(definition.description, /trash/i)
})

test('help and unknown commands are text-only results', async () => {
  const { service, cleanup } = await makeService()
  try {
    const help = await runButlerCommand(service, '')
    assert.equal(help.kind, 'success')
    assert.match(help.text, /restore <session-id>/)
    const unknown = await runButlerCommand(service, 'nope')
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /unknown command/)
  } finally {
    await cleanup()
  }
})

test('trash, list, restore and purge run through the command surface', async () => {
  const { service, cleanup } = await makeService()
  try {
    const trashed = await runButlerCommand(service, 'trash session-a', 'session-current')
    assert.equal(trashed.kind, 'success')
    assert.match(trashed.text, /session-a/)

    const listed = await runButlerCommand(service, 'list')
    assert.equal(listed.kind, 'success')
    assert.match(listed.text, /session-a/)

    const wrongConfirm = await runButlerCommand(service, 'purge session-a other', 'session-current')
    assert.equal(wrongConfirm.kind, 'error')
    assert.match(wrongConfirm.text, /confirm-mismatch/)

    const purged = await runButlerCommand(service, 'purge session-a session-a', 'session-current')
    assert.equal(purged.kind, 'success')
    const empty = await runButlerCommand(service, 'list')
    assert.match(empty.text, /empty/)
  } finally {
    await cleanup()
  }
})

test('command refuses trashing the issuing session', async () => {
  const { service, cleanup } = await makeService()
  try {
    const result = await runButlerCommand(service, 'trash session-a', 'session-a')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /cannot-trash-current/)
  } finally {
    await cleanup()
  }
})
