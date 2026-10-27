import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)

test('DSH compatibility is declared only through top-level engines.dsh', () => {
  assert.equal(typeof packageJson.engines.dsh, 'string')
  assert.ok(packageJson.engines.dsh.startsWith('>=0.2.1-rc.3'))
  assert.equal(packageJson.dsh.engines, undefined)
})

test('bundle and client manifests are declared', () => {
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.ok(Array.isArray(packageJson.dsh.client.inject))
  assert.equal(packageJson.exports['./client'], './lib/client.js')
  assert.equal(packageJson.exports['./package.json'], './package.json')
})

test('the publish closure covers every runtime resource', () => {
  const files = packageJson.files
  for (const required of [
    'lib',
    'locale',
    'icon.svg',
    'cordis.patch.yml',
    'README.md',
    'CHANGELOG.md',
    'docs/usage.md',
    'LICENSE',
  ]) {
    assert.ok(files.includes(required), `files must include ${required}`)
  }
  assert.equal(packageJson.private, undefined)
  assert.equal(packageJson.publishConfig.access, 'public')
})
