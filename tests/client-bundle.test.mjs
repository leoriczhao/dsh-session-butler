import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)
const bundlePath = new URL('../lib/client.js', import.meta.url)
const code = await readFile(bundlePath, 'utf8')

/**
 * Execute the classic script in a minimal browser-shaped sandbox and return the
 * registration it hands to the module loader.
 * @param {string} source - the bundled classic script
 */
function loadRegistration(source) {
  let registration
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value
        },
      },
    },
    console,
  }
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'lib/client.js' }).runInContext(sandbox)
  return registration
}

test('client bundle is a classic script registering the module factory', () => {
  const registration = loadRegistration(code)
  assert.ok(registration, 'client bundle never called window.__ModuleLoader__.load')
  assert.equal(registration.id, packageJson.name)
  assert.equal(typeof registration.factory, 'function')
})

test('client factory returns the plugin module without touching the module table', () => {
  const registration = loadRegistration(code)
  const requested = []
  const pluginModule = registration.factory((specifier) => {
    requested.push(specifier)
    throw new Error(`unexpected require(${JSON.stringify(specifier)}) in the foundation client half`)
  })
  assert.deepEqual(requested, [])
  assert.equal(typeof pluginModule.apply, 'function')
  assert.ok(Array.isArray(pluginModule.inject))
})

test('client bundle has no top-level ESM syntax or dynamic imports', () => {
  assert.doesNotMatch(code, /^\s*(?:import|export)\s/m)
  assert.doesNotMatch(code, /\bimport\s*\(/)
})
