import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Load the classic-script bundle and evaluate its factory with the real platform seeds. */
async function loadPlugin() {
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    console,
  }
  vm.createContext(sandbox)
  new vm.Script(code, { filename: 'lib/client.js' }).runInContext(sandbox)
  const react = await import('react')
  const jsxRuntime = await import('react/jsx-runtime')
  const table = { 'react': react, 'react/jsx-runtime': jsxRuntime }
  return registration.factory(specifier => table[specifier])
}

/** Fake Client context capturing locale/slot registrations and their cleanup. */
function makeContext({ immediateInjection = true } = {}) {
  const localeRegistrations = []
  const localeCleanups = []
  const slotRegistrations = []
  const slotCleanups = []
  let injectionCleanup
  let injectionCallback
  let effectCleanup
  const observed = { opened: [], refreshes: 0 }
  const ctx = {
    locale: {
      register(namespace, language, dict) {
        localeRegistrations.push({ namespace, language, dict })
        const cleanup = () => { localeCleanups.push(`${namespace}:${language}`) }
        return cleanup
      },
      bind(namespace) {
        const dict = localeRegistrations.find(entry => entry.namespace === namespace && entry.language === 'zh')?.dict ?? {}
        return (key, vars) => {
          let text = dict[key] ?? key
          for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value))
          return text
        }
      },
    },
    slots: {
      inject(name, callback) {
        injectionCallback = callback
        if (immediateInjection) injectionCleanup = callback()
        return () => { injectionCleanup?.() }
      },
      register(options, component) {
        slotRegistrations.push({ options, component })
        const cleanup = () => { slotCleanups.push(options.name) }
        return cleanup
      },
    },
    uiWorkspace: { openSession(id) { observed.opened.push(id) } },
    sessions: { async refresh() { observed.refreshes += 1 } },
    effect(execute) {
      effectCleanup = execute()
      return () => { effectCleanup?.() }
    },
    logger: { warn() {} },
  }
  return {
    ctx,
    localeRegistrations,
    localeCleanups,
    slotRegistrations,
    slotCleanups,
    observed,
    getInjectionCallback: () => injectionCallback,
    getEffectCleanup: () => effectCleanup,
  }
}

test('apply registers the main panel and its sidebar row in one injection', async () => {
  const plugin = await loadPlugin()
  assert.ok(plugin.inject.includes('slots'))
  assert.ok(plugin.inject.includes('locale'))
  assert.ok(plugin.inject.includes('uiWorkspace'))
  assert.ok(plugin.inject.includes('sessions'))

  const fake = makeContext()
  plugin.apply(fake.ctx)

  assert.equal(fake.localeRegistrations.length, 2)
  assert.deepEqual(fake.localeRegistrations.map(entry => entry.language).sort(), ['en', 'zh'])
  assert.ok(fake.localeRegistrations.every(entry => entry.namespace === 'session-butler'))
  assert.ok(fake.localeRegistrations.every(entry => typeof entry.dict.title === 'string'))

  assert.equal(fake.slotRegistrations.length, 2)
  const [panel, row] = fake.slotRegistrations
  assert.equal(panel.options.name, 'main')
  assert.equal(panel.options.key, 'session-butler')
  assert.equal(panel.options.locale, 'session-butler')
  const actions = panel.options.inject()
  assert.deepEqual(Object.keys(actions).sort(), ['call', 'openSession', 'refreshSessions'])
  assert.equal(row.options.name, 'sidebar.panellist')
  assert.equal(row.options.id, 'session-butler')
  assert.equal(row.options.label(), '会话管理')
  assert.equal(typeof panel.component, 'function')
  assert.equal(typeof row.component, 'function')
})

test('registrations happen only after the main slot is declared', async () => {
  const plugin = await loadPlugin()
  const fake = makeContext({ immediateInjection: false })
  plugin.apply(fake.ctx)
  assert.equal(fake.slotRegistrations.length, 0)
  assert.equal(fake.localeRegistrations.length, 2)
  const cleanup = fake.getInjectionCallback()()
  assert.equal(fake.slotRegistrations.length, 2)
  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.deepEqual(fake.slotCleanups, ['sidebar.panellist', 'main'])
})

test('effect disposal releases locale and slot registrations', async () => {
  const plugin = await loadPlugin()
  const fake = makeContext()
  plugin.apply(fake.ctx)
  const cleanup = fake.getEffectCleanup()
  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.deepEqual(fake.localeCleanups.sort(), ['session-butler:en', 'session-butler:zh'])
  assert.deepEqual(fake.slotCleanups, ['sidebar.panellist', 'main'])
})

test('the page renders session rows with the injected locale and actions', async () => {
  const plugin = await loadPlugin()
  const fake = makeContext()
  plugin.apply(fake.ctx)
  const panel = fake.slotRegistrations.find(entry => entry.options.name === 'main')
  assert.ok(panel)

  const t = (key, vars) => {
    const dict = fake.localeRegistrations.find(entry => entry.language === 'zh').dict
    let text = dict[key] ?? key
    for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
  const sessionState = {
    ids: ['session-a', 'session-b', 'session-c'],
    byId: {
      'session-a': {
        id: 'session-a', title: 'alpha', displayTitle: 'alpha', cwd: '/work/project', running: false,
        blank: false, updatedAt: 1_700_000_000_000,
      },
      'session-b': {
        id: 'session-b', displayTitle: 'beta', cwd: '/work/project', running: true,
        blank: false, updatedAt: 1_700_000_100_000,
      },
      'session-c': {
        id: 'session-c', displayTitle: 'gamma-child', cwd: '/work/project', running: false,
        blank: false, updatedAt: 1_700_000_050_000, origin: 'subagent',
      },
    },
    phase: 'ready',
  }
  const workspaceState = {
    items: [{ workspaceId: 'ws-1', path: '/work/project', title: 'project', sessionIds: ['session-a', 'session-b'] }],
    archivedSessionIds: [],
    pinnedSessionIds: [],
  }
  const props = {
    useSessions: select => select(sessionState),
    useWorkspaces: select => select(workspaceState),
    t,
    call: async () => ({ permanentDelete: 'disabled', retentionDays: 30, cascadeSubagents: true, workspaceAvailable: true }),
    openSession: () => {},
    refreshSessions: () => {},
  }
  const html = renderToStaticMarkup(React.createElement(panel.component, props))
  assert.match(html, /会话管理/)
  assert.match(html, /alpha/)
  assert.match(html, /移入回收站/)
  assert.match(html, /beta/)
  // Subagent sessions stay hidden until the filter is enabled.
  assert.doesNotMatch(html, /gamma-child/)
})
