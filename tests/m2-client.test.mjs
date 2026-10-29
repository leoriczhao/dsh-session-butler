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
  const injectionCallbacks = new Map()
  const injectionCleanups = new Map()
  let effectCleanup
  const observed = { opened: [], refreshes: 0, panels: [] }
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
        injectionCallbacks.set(name, callback)
        if (immediateInjection) injectionCleanups.set(name, callback())
        return () => { injectionCleanups.get(name)?.() }
      },
      register(options, component) {
        slotRegistrations.push({ options, component })
        const cleanup = () => { slotCleanups.push(options.name) }
        return cleanup
      },
    },
    uiWorkspace: { openSession(id) { observed.opened.push(id) } },
    sessions: { async refresh() { observed.refreshes += 1 } },
    layout: { selectPanel(id) { observed.panels.push(id) } },
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
    getInjectionCallback: name => injectionCallbacks.get(name),
    getEffectCleanup: () => effectCleanup,
  }
}

test('apply registers the main panel and Codex-style session menu items, not a sidebar row', async () => {
  const plugin = await loadPlugin()
  assert.ok(plugin.inject.includes('slots'))
  assert.ok(plugin.inject.includes('locale'))
  assert.ok(plugin.inject.includes('uiWorkspace'))
  assert.ok(plugin.inject.includes('sessions'))
  assert.ok(plugin.inject.includes('layout'))

  const fake = makeContext()
  plugin.apply(fake.ctx)

  assert.equal(fake.localeRegistrations.length, 2)
  assert.deepEqual(fake.localeRegistrations.map(entry => entry.language).sort(), ['en', 'zh'])
  assert.ok(fake.localeRegistrations.every(entry => entry.namespace === 'session-butler'))
  assert.ok(fake.localeRegistrations.every(entry => typeof entry.dict.title === 'string'))

  assert.equal(fake.slotRegistrations.length, 7)
  const pluginSlots = fake.slotRegistrations.filter(entry => entry.options.name.startsWith('plugins.'))
  assert.deepEqual(pluginSlots.map(entry => entry.options.name).sort(), [
    'plugins.bundle.config',
    'plugins.detail.badge',
    'plugins.detail.section',
    'plugins.row.config',
  ])
  const rowConfig = pluginSlots.find(entry => entry.options.name === 'plugins.row.config')
  assert.equal(rowConfig.options.key, 'dsh-session-butler#session-butler')
  assert.equal(pluginSlots.find(entry => entry.options.name === 'plugins.bundle.config').options.key, 'dsh-session-butler')
  const panel = fake.slotRegistrations.find(entry => entry.options.name === 'main')
  assert.ok(panel)
  assert.equal(panel.options.key, 'session-butler')
  assert.equal(panel.options.locale, 'session-butler')
  const actions = panel.options.inject()
  assert.deepEqual(Object.keys(actions).sort(), ['call', 'openSession', 'refreshSessions'])

  // No permanent navigation button: the old `sidebar.panellist` row is gone.
  assert.equal(fake.slotRegistrations.some(entry => entry.options.name === 'sidebar.panellist'), false)
  const menus = fake.slotRegistrations.filter(entry => entry.options.name === 'sidebar.workspaces.session.menu.item')
  assert.deepEqual(menus.map(entry => entry.options.id), ['threadloom.detail', 'threadloom.library'])
  assert.deepEqual(menus.map(entry => entry.options.order), [460, 470])
  assert.ok(menus.every(entry => entry.options.locale === 'session-butler'))
  assert.equal(typeof panel.component, 'function')
  assert.ok(menus.every(entry => typeof entry.component === 'function'))
})

test('each slot registers only after its own declaration', async () => {
  const plugin = await loadPlugin()
  const fake = makeContext({ immediateInjection: false })
  plugin.apply(fake.ctx)
  assert.equal(fake.slotRegistrations.length, 0)
  assert.equal(fake.localeRegistrations.length, 2)

  // The row-menu slot is independent from `main`: declaring only the panel must
  // not attempt to register its entries (the real boot bug class).
  const cleanupPanel = fake.getInjectionCallback('main')()
  assert.deepEqual(fake.slotRegistrations.map(entry => entry.options.name), ['main'])
  assert.equal(typeof cleanupPanel, 'function')
  assert.equal(fake.slotRegistrations.some(entry => entry.options.name === 'sidebar.workspaces.session.menu.item'), false)

  const cleanupDetail = fake.getInjectionCallback('sidebar.workspaces.session.menu.item')()
  assert.deepEqual(fake.slotRegistrations.map(entry => entry.options.name), [
    'main',
    'sidebar.workspaces.session.menu.item',
  ])
  cleanupDetail()
  cleanupPanel()
  assert.deepEqual(fake.slotCleanups, ['sidebar.workspaces.session.menu.item', 'main'])
})

test('effect disposal releases locale and slot registrations', async () => {
  const plugin = await loadPlugin()
  const fake = makeContext()
  plugin.apply(fake.ctx)
  const cleanup = fake.getEffectCleanup()
  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.deepEqual(fake.localeCleanups.sort(), ['session-butler:en', 'session-butler:zh'])
  assert.deepEqual(fake.slotCleanups, [
    'plugins.detail.section',
    'plugins.detail.badge',
    'plugins.bundle.config',
    'plugins.row.config',
    'sidebar.workspaces.session.menu.item',
    'sidebar.workspaces.session.menu.item',
    'main',
  ])
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
  assert.match(html, /会话库/)
  assert.match(html, /alpha/)
  assert.match(html, /移入回收站/)
  assert.match(html, /beta/)
  // Subagent sessions stay hidden until the filter is enabled.
  assert.doesNotMatch(html, /gamma-child/)
})

/** Bind the Chinese dictionary for direct component rendering. */
function zhTranslator(fake) {
  return (key, vars) => {
    const dict = fake.localeRegistrations.find(entry => entry.language === 'zh').dict
    let text = dict[key] ?? key
    for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

test('the page renders batch selection affordances for both tabs', async () => {
  const plugin = await loadPlugin()
  const fake = makeContext()
  plugin.apply(fake.ctx)
  const panel = fake.slotRegistrations.find(entry => entry.options.name === 'main')
  const t = zhTranslator(fake)
  const sessionState = {
    ids: ['session-a'],
    byId: {
      'session-a': {
        id: 'session-a', displayTitle: 'alpha', cwd: '/work/project', running: false,
        blank: false, updatedAt: 1_700_000_000_000,
      },
    },
    phase: 'ready',
  }
  const workspaceState = { items: [], archivedSessionIds: [], pinnedSessionIds: [] }
  const html = renderToStaticMarkup(React.createElement(panel.component, {
    useSessions: select => select(sessionState),
    useWorkspaces: select => select(workspaceState),
    t,
    call: async () => ({ permanentDelete: 'disabled', retentionDays: 30, cascadeSubagents: true, workspaceAvailable: true }),
    openSession: () => {},
    refreshSessions: () => {},
  }))
  assert.match(html, /全选当前列表/)
  assert.match(html, /已选 0 项/)
  assert.match(html, /详情/)
  // Two filter toggles, one select-all box, and one box per visible row.
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 4)
  // Batch actions stay hidden until something is selected.
  assert.doesNotMatch(html, /移入回收站（1）/)
})

test('SessionDetailView renders figures, token totals, size and lineage', async () => {
  const plugin = await loadPlugin()
  const fake = makeContext()
  plugin.apply(fake.ctx)
  assert.equal(typeof plugin.SessionDetailView, 'function')
  const t = zhTranslator(fake)
  const detail = {
    id: 'session-root',
    headerSnapshot: {
      id: 'session-root',
      cwd: '/work/project',
      createdAt: 1_700_000_000_000,
      agentPreset: 'build',
    },
    formatStatus: 'migration-required',
    live: true,
    descendantIds: ['session-child'],
    enrichment: { status: 'partial', reason: 'read-failed' },
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
    },
    lineage: {
      complete: false,
      missingParentId: 'session-gone',
      ancestors: [{ id: 'session-parent', cwd: '/work/project' }],
      descendants: [{
        id: 'session-child',
        origin: 'subagent',
        agentPreset: 'build',
        descendants: [{ id: 'session-grandchild', origin: 'subagent', descendants: [] }],
      }],
    },
  }
  const html = renderToStaticMarkup(React.createElement(plugin.SessionDetailView, { detail, t }))
  assert.match(html, /会话详情|ID/)
  assert.match(html, /session-root/)
  assert.match(html, /创建时间/)
  assert.match(html, /build/)
  assert.match(html, /部分统计不可用（read-failed）/)
  assert.match(html, /轮次 2 · 步骤 3 · 用户 2 · 助手 2 · 工具 4\/4/)
  assert.match(html, /Token 输入 100 · 输出 50 · 缓存读 10 · 缓存写 5/)
  assert.match(html, /日志 4\.0 KB · 20 个事件/)
  assert.match(html, /父会话 session-gone 已不可用/)
  assert.match(html, /子代理后代（2）/)
  assert.match(html, /session-grandchild/)
})
