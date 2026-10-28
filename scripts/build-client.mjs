#!/usr/bin/env node
/**
 * Build the Web Client half as a DSH classic-script module factory.
 *
 * DSH loads a plugin's `./client` as a plain <script>, so the artifact must not contain
 * top-level import/export/await. It must call
 * `window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => ... })`
 * and return the module exports from the factory.
 *
 * Everything in PLATFORM_SEED is provided by the browser module table and must stay
 * external (shared identity). Everything else is inlined unless the package declares it in
 * `dsh.client.external`.
 *
 * @see docs/dsh-packaging-contract.md §4, §6.3
 */

import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const id = manifest.name

/**
 * The browser module table shared by the Web shell.
 * Must stay in sync with packages/client/web/src/platform.ts (PLATFORM_MODULES) of the
 * DSH version declared in `engines.dsh`.
 */
const PLATFORM_SEED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const declaredExternals = manifest.dsh?.client?.external ?? []
if (!Array.isArray(declaredExternals)) {
  throw new Error('dsh.client.external must be an array of module specifiers')
}
for (const specifier of declaredExternals) {
  if (PLATFORM_SEED.includes(specifier)) {
    throw new Error(
      `dsh.client.external must not repeat a platform seed module: ${specifier}`,
    )
  }
}

const outfile = path.join(root, 'lib', 'client.js')
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {
var module = { exports: {} }; var exports = module.exports;`
const footer = 'return module.exports; } });'

await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'src/client/index.tsx')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  logLevel: 'info',
  external: [...PLATFORM_SEED, ...declaredExternals],
  banner: { js: banner },
  footer: { js: footer },
})

const code = await readFile(outfile, 'utf8')
// esbuild appends the source-map comment after the footer; check the code before it.
const codeWithoutMapComment = code.trimEnd().replace(/\/\/# sourceMappingURL=.*$/, '').trimEnd()

const failures = []
if (!code.includes(`window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`)) {
  failures.push('bundle does not call window.__ModuleLoader__.load with the package id')
}
if (!codeWithoutMapComment.endsWith('return module.exports; } });')) {
  failures.push('bundle does not close the module factory with `return module.exports`')
}
if (/^\s*(?:import|export)\s/m.test(code)) {
  failures.push('bundle contains top-level ESM import/export syntax')
}
if (/\bimport\s*\(/.test(code)) {
  failures.push('bundle contains a dynamic import(); the first release ships a single client.js')
}
if (failures.length > 0) {
  console.error(`build-client: invalid client bundle at ${outfile}:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`build-client: wrote ${path.relative(root, outfile)} (${code.length} bytes)`)
