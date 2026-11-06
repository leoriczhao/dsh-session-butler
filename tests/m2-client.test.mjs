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

/** One fake DSH config form with a static first snapshot. */
function makeConfigForm(value) {
  const snapshot = { status: 'ready', value, revision: 7, writable: true }
  return {
    getSnapshot: () => snapshot,
    subscribe() { return () => {} },
    async mutate() { return true },
    async set() { return true },
  }
}

/**
 * Fake Client context capturing locale/slot registrations and their cleanup.
 * `immediateInjection: false` keeps every inject callback for late binding.
 */
function makeContext({ immediateInjection = true, configValue, language = 'zh' } = {}) {
  const localeRegistrations = []
  const localeCleanups = []
  const slotRegistrations = []
  const slotCleanups = []
  const injectionCallbacks = new Map()
  let effectCleanup
  const observed = { opened: [], refreshes: 0, unarchived: [] }
  const configForm = makeConfigForm(configValue ?? {
    inlineMenuEnabled: true,
    trashRetentionDays: 30,
    cascadeSubagents: true,
    permanentDelete: 'confirm',
    liveSettleTimeoutMs: 3000,
  })
  const ctx = {
    locale: {
      register(namespace, language, dict) {
        localeRegistrations.push({ namespace, language, dict })
        return () => { localeCleanups.push(namespace + ':' + language) }
      },
      bind(namespace) {
        const dict = localeRegistrations.find(entry => entry.namespace === namespace && entry.language === language)?.dict ?? {}
        return (key, vars) => {
          let text = dict[key] ?? key
          for (const [name, value] of Object.entries(vars ?? {})) text = text.split('{' + name + '}').join(String(value))
          return text
        }
      },
    },
    slots: {
      inject(name, callback) {
        const list = injectionCallbacks.get(name) ?? []
        list.push(callback)
        injectionCallbacks.set(name, list)
        let dispose
        if (immediateInjection) dispose = callback()
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
      register(options, component) {
        slotRegistrations.push({ options, component })
        return () => { slotCleanups.push(options.name) }
      },
    },
    uiWorkspace: {
      openSession(id) { observed.opened.push(id) },
      async unarchiveSession(id) { observed.unarchived.push(id) },
    },
    sessions: { async refresh() { observed.refreshes += 1 } },
    get(name) {
      if (name === 'configForms') return { get: () => configForm }
      return undefined
    },
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
    injectionCallbacks,
    observed,
    configForm,
    getEffectCleanup: () => effectCleanup,
  }
}

test('apply registers Codex-style settings sections and no library/nav entries', async () => {
  const plugin = await loadPlugin()
  assert.deepEqual([...plugin.inject].sort(), ['locale', 'sessions', 'slots', 'uiWorkspace'])

  const fake = makeContext()
  plugin.apply(fake.ctx)

  assert.equal(fake.localeRegistrations.length, 2)
  assert.deepEqual(fake.localeRegistrations.map(entry => entry.language).sort(), ['en', 'zh'])
  assert.ok(fake.localeRegistrations.every(entry => entry.namespace === 'session-butler'))
  assert.ok(fake.localeRegistrations.every(entry => typeof entry.dict['settings.archived'] === 'string'))

  const names = fake.slotRegistrations.map(entry => entry.options.name)
  assert.deepEqual(names.filter(name => name === 'settings.section').length, 2)
  assert.equal(names.filter(name => name === 'sidebar.workspaces.session.menu.item').length, 1)
  assert.deepEqual(names.filter(name => name.startsWith('plugins.')).sort(), [
    'plugins.detail.badge',
    'plugins.detail.section',
  ])
  assert.equal(names.includes('main'), false)
  assert.equal(names.includes('sidebar.panellist'), false)
  assert.equal(names.includes('plugins.row.config'), false)
  assert.equal(names.includes('plugins.bundle.config'), false)
  assert.equal(names.includes('plugins.detail.actions'), false)

  const sections = fake.slotRegistrations.filter(entry => entry.options.name === 'settings.section')
  assert.deepEqual(sections.map(entry => entry.options.id), ['archived-sessions', 'threadloom'])
  assert.deepEqual(sections.map(entry => entry.options.order), [44, 45])
  assert.deepEqual(sections.map(entry => entry.options.label()), ['已归档的聊天', 'Threadloom'])
  assert.ok(sections.every(entry => typeof entry.component === 'function'))

  const menu = fake.slotRegistrations.find(entry => entry.options.name === 'sidebar.workspaces.session.menu.item')
  assert.equal(menu.options.id, 'threadloom.delete')
  assert.equal(menu.options.order, 470)
})

test('delete failure guidance is available in English and Chinese', async () => {
  const plugin = await loadPlugin()
  const fake = makeContext()
  plugin.apply(fake.ctx)
  const english = fake.localeRegistrations.find(entry => entry.language === 'en').dict
  const chinese = fake.localeRegistrations.find(entry => entry.language === 'zh').dict

  for (const dict of [english, chinese]) {
    for (const key of ['menu.delete.running', 'menu.delete.inUse', 'menu.delete.locked', 'menu.delete.failed']) {
      assert.match(dict[key], /\{title\}/, key)
    }
  }
  assert.match(english['menu.delete.running'], /still in use/i)
  assert.match(chinese['menu.delete.running'], /仍在使用中/)
  assert.match(english['menu.delete.inUse'], /restart DSH/i)
  assert.match(chinese['menu.delete.inUse'], /重启 DSH/)
  assert.match(english['menu.delete.body'], /subagent/i)
  assert.match(chinese['menu.delete.body'], /子代理/)
  assert.match(english['menu.delete.failed'], /could not confirm whether/i)
  assert.match(chinese['menu.delete.failed'], /无法确认.*是否已删除/)
})

test('each slot registers only after its own declaration', async () => {
  const plugin = await loadPlugin()
  const fake = makeContext({ immediateInjection: false })
  plugin.apply(fake.ctx)
  assert.equal(fake.slotRegistrations.length, 0)
  assert.equal(fake.localeRegistrations.length, 2)

  const sectionCallbacks = fake.injectionCallbacks.get('settings.section') ?? []
  assert.equal(sectionCallbacks.length, 2)
  for (const callback of sectionCallbacks) callback()
  assert.deepEqual(
    fake.slotRegistrations.map(entry => entry.options.name),
    ['settings.section', 'settings.section'],
  )

  const menuCallbacks = fake.injectionCallbacks.get('sidebar.workspaces.session.menu.item') ?? []
  assert.equal(menuCallbacks.length, 1)
  menuCallbacks[0]()
  assert.equal(fake.slotRegistrations.length, 3)
  assert.equal(fake.slotRegistrations[2].options.name, 'sidebar.workspaces.session.menu.item')
})

test('effect disposal releases locale and every slot registration', async () => {
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
    'sidebar.workspaces.session.menu.item',
    'settings.section',
    'settings.section',
  ])
})

test('the archived-chats page renders the Codex settings surface', async () => {
  const plugin = await loadPlugin()
  const fake = makeContext()
  plugin.apply(fake.ctx)
  const section = fake.slotRegistrations.find(entry => entry.options.id === 'archived-sessions')
  const html = renderToStaticMarkup(React.createElement(section.component, { close() {} }))
  assert.match(html, /已归档的聊天/)
  assert.match(html, /搜索已归档的聊天/)
  assert.match(html, /全部删除/)
  assert.match(html, /正在加载已归档聊天/)
  assert.doesNotMatch(html, /会话库/)
})

test('the config page renders the four plugin fields in Settings', async () => {
  const plugin = await loadPlugin()
  const fake = makeContext()
  plugin.apply(fake.ctx)
  const section = fake.slotRegistrations.find(entry => entry.options.id === 'threadloom')
  const html = renderToStaticMarkup(React.createElement(section.component, { close() {} }))
  assert.match(html, /Threadloom 设置/)
  assert.match(html, /回收站保留天数/)
  assert.match(html, /等待会话释放超时/)
  assert.match(html, /级联删除子代理会话/)
  assert.match(html, /会话行菜单动作/)
  assert.doesNotMatch(html, /永久删除/)
})

test('the row menu matches host delete icon and session labels in both languages', async () => {
  const plugin = await loadPlugin()
  const props = {
    sessionId: 'session-a',
    displayTitle: 'alpha',
    useMenuOpenState: () => [false, () => {}],
  }

  for (const [language, label] of [['zh', '删除会话'], ['en', 'Delete session']]) {
    const fake = makeContext({ language })
    plugin.apply(fake.ctx)
    const menu = fake.slotRegistrations.find(entry => entry.options.name === 'sidebar.workspaces.session.menu.item')
    const html = renderToStaticMarkup(React.createElement(menu.component, props))
    const button = html.match(/<button[^>]*role="menuitem"[^>]*>.*?<\/button>/)?.[0]
    assert.ok(button, `${language} row renders a menu item`)
    assert.equal((html.match(/role="menuitem"/g) ?? []).length, 1)
    assert.doesNotMatch(html, /回收站|会话库|会话详情/)
    assert.match(button, /<svg[^>]*width="14"[^>]*height="14"[^>]*viewBox="0 0 16 16"[^>]*aria-hidden="true"/)
    assert.match(button, /stroke="currentColor"/)
    assert.match(button, /M1\.28149 3\.88831H14\.7187/)
    assert.equal((button.match(/<path /g) ?? []).length, 5)
    assert.ok(button.endsWith(`</svg>${label}</button>`))
  }

  const disabled = makeContext({ configValue: { inlineMenuEnabled: false } })
  plugin.apply(disabled.ctx)
  const disabledMenu = disabled.slotRegistrations.find(entry => entry.options.name === 'sidebar.workspaces.session.menu.item')
  assert.equal(renderToStaticMarkup(React.createElement(disabledMenu.component, props)), '')
})
