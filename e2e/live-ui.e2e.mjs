/**
 * L2 browser lane: one Playwright walk over the real Web GUI, against a
 * disposable `dsh web` profile that loads the built plugin through the real
 * Loader. It covers the Codex-shaped surface: Settings has an Archived chats
 * section and a Threadloom section (no Trash page), a session row's inline
 * action deletes permanently, and an archived chat can be deleted from Settings
 * with no trash residue afterwards.
 *
 * Chats are seeded as idle persisted Sessions (the same JSONL format the Host
 * writes) so this lane never needs a model provider and never waits on a live
 * agent turn. Everything else runs through the real Web server and GUI.
 */
import assert from 'node:assert/strict'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'

import { chromium } from 'playwright'

import { REPO_ROOT, createDshHome, startDshWeb, waitFor } from './support/dsh.mjs'

const CHROME = process.env.DSH_E2E_CHROME

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(CHROME ? { executablePath: CHROME } : {}),
  })
}

/** Call one Threadloom bridge method from inside the authenticated page. */
async function bridge(page, method, body = {}) {
  return page.evaluate(async ({ method, body }) => {
    const response = await fetch(`session-butler/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }, { method, body })
}

async function listSessions(page, filters = {}) {
  const answer = await bridge(page, 'list', { limit: 100, includeArchived: true, ...filters })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true, JSON.stringify(answer.body))
  return answer.body.value
}

/** Keep the first-run sign-in dialog closed if it reappears while the page is idle. */
async function installWelcomeAutoClose(page) {
  await page.evaluate(() => {
    if (globalThis.__dshE2eWelcomeObserver !== undefined) return
    const close = () => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find(candidate => /Get started|Welcome|Sign in/i.test(candidate.getAttribute('aria-label') ?? ''))
      if (dialog === undefined || dialog.offsetParent === null) return
      const button = [...dialog.querySelectorAll('button')]
        .find(candidate => /^Close$/i.test((candidate.getAttribute('aria-label') ?? '').trim()))
      if (button !== undefined) button.click()
    }
    const observer = new MutationObserver(() => { setTimeout(close, 0) })
    observer.observe(document.body, { childList: true, subtree: true })
    globalThis.__dshE2eWelcomeObserver = observer
  })
}

/** Dismiss the first-run sign-in/welcome dialogs this profile presents. */
async function dismissWelcome(page) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')]
      const close = buttons.find(button => /^Close$/i.test((button.getAttribute('aria-label') ?? '').trim()))
        ?? buttons.find(button => /^(Continue|继续|Close)$/i.test((button.textContent ?? '').trim()))
      if (close === undefined || close.offsetParent === null) return false
      close.click()
      return true
    })
    if (!clicked) break
    await sleep(400)
  }
  await page.keyboard.press('Escape')
  await sleep(300)
}

async function openSettings(page) {
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ state: 'visible', timeout: 15_000 })
  return dialog
}

async function closeSettings(page) {
  await page.keyboard.press('Escape')
  await waitFor(async () => (await page.getByRole('dialog').count()) === 0, {
    timeout: 10_000, label: 'settings dialog closed',
  })
}

/** Expand every workspace group so session rows in both workspaces render. */
async function expandWorkspaces(page) {
  for (const title of ['alpha', 'beta']) {
    const row = page.getByRole('treeitem').filter({ hasText: title }).first()
    if (await row.count() === 0) continue
    if (await row.getAttribute('aria-expanded') === 'false') await row.click()
  }
  await sleep(300)
}

/** Hover one session row and click the row's own "..." action. */
async function openRowMenu(page, session) {
  await expandWorkspaces(page)
  const row = page.locator(`[data-row-key="session:${session.id}"]`).first()
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await sleep(300)
  const action = row.locator('button[aria-label^="Session actions for"]').first()
  await action.click()
  await page.waitForTimeout(300)
}

async function deleteFromRowMenu(page, session) {
  let confirmation = ''
  page.once('dialog', async dialog => {
    confirmation = dialog.message()
    await dialog.accept()
  })
  await openRowMenu(page, session)
  await page.getByRole('menuitem', { name: /Delete chat/ }).click()
  await waitFor(async () => {
    const sessions = (await listSessions(page)).sessions
    return !sessions.some(entry => entry.id === session.id)
  }, { timeout: 20_000, interval: 300, label: 'row-menu permanent delete' })
  assert.match(confirmation, /permanently deleted/i)
}

/** Exercise a rejected delete through the actual row menu without changing Host data. */
async function expectRowDeleteFailure(page, home, session, failure, expectedMessage) {
  const requests = []
  const dialogs = []
  const intercept = async route => {
    requests.push(route.request().postDataJSON())
    if (failure === null) {
      await route.abort('failed')
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: failure }),
      })
    }
  }
  const handleDialog = async dialog => {
    const record = { type: dialog.type(), message: dialog.message(), accepted: false }
    dialogs.push(record)
    await dialog.accept()
    record.accepted = true
  }
  await page.route('**/session-butler/api/delete', intercept)
  page.on('dialog', handleDialog)
  try {
    await openRowMenu(page, session)
    await page.getByRole('menuitem', { name: /Delete chat/ }).click()
    await waitFor(() => dialogs.some(dialog => dialog.type === 'alert')
      && dialogs.every(dialog => dialog.accepted), {
      timeout: 5_000, label: 'visible delete failure',
    })
    assert.deepEqual(dialogs.map(dialog => dialog.type), ['confirm', 'alert'])
    assert.match(dialogs[0].message, /permanently deleted/i)
    assert.match(dialogs[1].message, expectedMessage)
    await page.locator(`[data-row-key="session:${session.id}"]`).waitFor({ state: 'visible' })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].sessionId, session.id)
    assert.ok((await listSessions(page)).sessions.some(entry => entry.id === session.id))
    assert.equal(await hasSessionDirectory(home, session.id), true)
  } finally {
    page.off('dialog', handleDialog)
    await page.unroute('**/session-butler/api/delete', intercept)
  }
}

/** Cause a real Host preflight failure in the disposable profile, then remove it. */
async function expectRealDeleteFailure(page, home, session) {
  const sessionsRoot = join(home, 'sessions')
  const projects = await readdir(sessionsRoot, { withFileTypes: true })
  const matches = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const entries = await readdir(join(sessionsRoot, project.name))
    if (entries.includes(session.id)) matches.push(project.name)
  }
  assert.equal(matches.length, 1, 'find the seeded session directory')
  const projectTrash = join(home, 'session-butler', 'trash', matches[0])
  const conflict = join(projectTrash, session.id + '.json')
  await mkdir(projectTrash, { recursive: true })
  await writeFile(conflict, '{}', { flag: 'wx' })

  const dialogs = []
  const handleDialog = async dialog => {
    const record = { type: dialog.type(), message: dialog.message(), accepted: false }
    dialogs.push(record)
    await dialog.accept()
    record.accepted = true
  }
  page.on('dialog', handleDialog)
  try {
    await openRowMenu(page, session)
    const responsePromise = page.waitForResponse(response =>
      response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/session-butler/api/delete'))
    const [, response] = await Promise.all([
      page.getByRole('menuitem', { name: /Delete chat/ }).click(),
      responsePromise,
    ])
    const body = await response.json()
    assert.equal(response.status(), 200)
    assert.equal(response.request().postDataJSON().sessionId, session.id)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'trash-conflict')
    await waitFor(() => dialogs.some(dialog => dialog.type === 'alert')
      && dialogs.every(dialog => dialog.accepted), {
      timeout: 5_000, label: 'visible Host delete failure',
    })
    assert.deepEqual(dialogs.map(dialog => dialog.type), ['confirm', 'alert'])
    assert.match(dialogs[0].message, /permanently deleted/i)
    assert.match(dialogs[1].message, /could not confirm whether.*was deleted/i)
    await page.locator(`[data-row-key="session:${session.id}"]`).waitFor({ state: 'visible' })
    assert.ok((await listSessions(page)).sessions.some(entry => entry.id === session.id))
    assert.equal(await hasSessionDirectory(home, session.id), true)
  } finally {
    page.off('dialog', handleDialog)
    await unlink(conflict)
  }
}

async function archiveFromRowMenu(page, session) {
  await openRowMenu(page, session)
  await page.getByRole('menuitem', { name: /Archive session/ }).click()
  await waitFor(async () => {
    const archived = (await listSessions(page, { archivedOnly: true })).sessions
    return archived.some(entry => entry.id === session.id)
  }, { timeout: 15_000, interval: 300, label: 'session archived' })
}

/** True when any directory under the home's sessions root carries this id. */
async function hasSessionDirectory(home, sessionId) {
  const stack = [join(home, 'sessions')]
  while (stack.length > 0) {
    const dir = stack.pop()
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.includes(sessionId)) return true
      if (entry.isDirectory()) stack.push(join(dir, entry.name))
    }
  }
  return false
}

test('Settings and permanent deletion work in the assembled Web GUI', { timeout: 180_000 }, async () => {
  const fixture = await createDshHome({
    seedSessions: [
      { workspace: 'alpha', title: 'L2 alpha seeded chat' },
      { workspace: 'beta', title: 'L2 beta seeded chat' },
    ],
  })
  const alpha = fixture.sessions.find(session => session.workspace === 'alpha')
  const beta = fixture.sessions.find(session => session.workspace === 'beta')
  assert.ok(alpha !== undefined && beta !== undefined)
  let server
  let browser
  let page
  try {
    server = await startDshWeb(fixture.home)
    browser = await launchBrowser()
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(4_000)
    await installWelcomeAutoClose(page)
    await dismissWelcome(page)

    // Settings: Codex-shaped archived chats and Threadloom config, no Trash page.
    const dialog = await openSettings(page)
    const nav = (await dialog.locator('nav button').allInnerTexts()).map(text => text.trim())
    assert.ok(nav.includes('Archived chats'), `settings nav is ${JSON.stringify(nav)}`)
    assert.ok(nav.includes('Threadloom'), `settings nav is ${JSON.stringify(nav)}`)
    assert.ok(!nav.some(text => /Trash|回收站/.test(text)), `unexpected trash section: ${JSON.stringify(nav)}`)
    assert.ok(!nav.some(text => /Session library|会话库/.test(text)), `unexpected library section: ${JSON.stringify(nav)}`)

    await dialog.getByRole('button', { name: 'Archived chats' }).click()
    await waitFor(async () => (await dialog.innerText()).includes('Archived chats'), {
      timeout: 10_000, label: 'archived chats page',
    })
    await dialog.getByRole('button', { name: 'Threadloom' }).click()
    await waitFor(async () => (await dialog.innerText()).includes('Threadloom settings'), {
      timeout: 10_000, label: 'Threadloom settings page',
    })
    assert.equal(await dialog.locator('input[type="number"]').count(), 2)
    await closeSettings(page)

    await waitFor(async () => {
      await expandWorkspaces(page)
      const counts = await Promise.all([alpha, beta].map(session =>
        page.locator(`[data-row-key="session:${session.id}"]`).count()))
      return counts.every(count => count === 1)
    }, { timeout: 20_000, interval: 500, label: 'seeded sessions in the sidebar' })

    // A rejected request must be visible after the row menu closes, and retryable.
    await expectRowDeleteFailure(page, fixture.home, alpha, {
      code: 'session-running',
      message: 'session is still running after stop was requested',
    }, /still in use/i)
    await expectRowDeleteFailure(page, fixture.home, alpha, {
      code: 'session-locked',
      message: 'session is held by another writer',
    }, /in use by another process/i)
    await expectRowDeleteFailure(page, fixture.home, alpha, null,
      /could not confirm whether.*was deleted/i)
    await expectRealDeleteFailure(page, fixture.home, alpha)

    // D-030 one-step delete from the session row menu, with no trash residue.
    await deleteFromRowMenu(page, alpha)
    assert.equal(await hasSessionDirectory(fixture.home, alpha.id), false)
    assert.equal((await bridge(page, 'status')).body.value.storage.trashCount, 0)

    // Archived chats keep the same one-step delete through Settings.
    await archiveFromRowMenu(page, beta)
    const archived = await openSettings(page)
    await archived.getByRole('button', { name: 'Archived chats' }).click()
    await waitFor(async () => (await archived.innerText()).includes('L2 beta seeded chat'), {
      timeout: 15_000, label: 'archived row visible',
    })
    const row = archived.locator('.sb-settings-row').filter({ hasText: 'L2 beta seeded chat' }).first()
    await row.getByRole('button', { name: /Delete permanently/ }).click()
    const confirm = archived.getByRole('dialog')
    await confirm.waitFor({ state: 'visible', timeout: 10_000 })
    await confirm.getByRole('button', { name: /Delete permanently/ }).click()
    await waitFor(async () => {
      const sessions = (await listSessions(page, { archivedOnly: true })).sessions
      return !sessions.some(entry => entry.id === beta.id)
    }, { timeout: 20_000, interval: 300, label: 'archived permanent delete' })
    assert.equal(await hasSessionDirectory(fixture.home, beta.id), false)
    assert.equal((await bridge(page, 'status')).body.value.storage.trashCount, 0)
  } catch (error) {
    if (page !== undefined) {
      const artifacts = join(REPO_ROOT, 'e2e', '.artifacts')
      await mkdir(artifacts, { recursive: true })
      await page.screenshot({ path: join(artifacts, 'l2-failure.png'), fullPage: true }).catch(() => {})
    }
    throw error
  } finally {
    await browser?.close().catch(() => {})
    await server?.stop()
    await fixture.cleanup()
  }
})
