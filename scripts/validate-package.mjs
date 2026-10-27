#!/usr/bin/env node
/**
 * Validate the publishable package against the DSH npm plugin contract.
 *
 * This is the pre-publish gate: it checks the manifest fields DSH actually reads, resolves
 * every runtime export, validates the display resources (locale/icon/detail), and compares
 * the `npm pack` file closure against what `files`/`exports` promise.
 *
 * Assumes `npm run build` already ran; it passes `--ignore-scripts` to `npm pack` so the
 * JSON output stays parseable and prepack does not rebuild.
 *
 * @see docs/dsh-packaging-contract.md §2, §5, §10, §11
 */

import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { parse as parseYaml } from 'yaml'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-session-butler'

const errors = []
const warnings = []
let checks = 0

/** @param {boolean} condition @param {string} message */
function check(condition, message) {
  checks += 1
  if (!condition) errors.push(message)
}

/** @param {boolean} condition @param {string} message */
function warnWhen(condition, message) {
  checks += 1
  if (condition) warnings.push(message)
}

async function exists(relativePath) {
  try {
    await stat(path.join(root, relativePath))
    return true
  } catch {
    return false
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))
}

const pkg = await readJson('package.json')

// --- Identity and publishing -------------------------------------------------------------
check(pkg.name === packageName, `package.json name must be "${packageName}" (got ${JSON.stringify(pkg.name)})`)
check(typeof pkg.version === 'string' && semver.valid(pkg.version) !== null, 'package.json version must be a valid semantic version')
check(pkg.private !== true, 'package.json must not set "private": true when publishing')
check(pkg.type === 'module', 'package.json must set "type": "module" for the Host ESM half')
check(typeof pkg.description === 'string' && pkg.description.length > 0, 'package.json needs a description')
check(pkg.license === 'MIT', 'package.json license must be MIT')
check(Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin'), 'package.json keywords should include "dsh-plugin"')

// --- DSH compatibility -------------------------------------------------------------------
check(typeof pkg.engines?.dsh === 'string', 'top-level engines.dsh is required (dsh.engines is never read)')
check(pkg.dsh?.engines === undefined, 'dsh.engines is ignored by DSH; use top-level engines.dsh instead')
const shimPeers = Object.keys(pkg.peerDependencies ?? {}).filter(
  (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
)
warnWhen(
  shimPeers.length > 0,
  `@deepseek-ai/dsh* peers are only used when engines.dsh is absent and would be compared against the running DSH version: ${shimPeers.join(', ')}`,
)

// --- Bundle patch ------------------------------------------------------------------------
check(pkg.dsh?.bundle?.patch !== undefined, 'package.json must declare dsh.bundle.patch')
const patchFiles = Array.isArray(pkg.dsh?.bundle?.patch) ? pkg.dsh.bundle.patch : [pkg.dsh?.bundle?.patch]
for (const patchFile of patchFiles) {
  if (typeof patchFile !== 'string') {
    errors.push('dsh.bundle.patch entries must be strings')
    continue
  }
  check(await exists(patchFile), `bundle patch file is missing: ${patchFile}`)
  const document = parseYaml(await readFile(path.join(root, patchFile), 'utf8'))
  check(Array.isArray(document), `${patchFile} must be a YAML array of loader patch entries`)
  const rows = Array.isArray(document)
    ? document.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
    : []
  check(rows.length > 0, `${patchFile} must insert at least one row`)
  for (const row of rows) {
    check(typeof row?.id === 'string' && row.id.length > 0, `${patchFile} row needs a string id`)
    check(
      row?.name === pkg.name,
      `${patchFile}: row name must be the bare package name "${pkg.name}" so the Client half is discovered (got ${JSON.stringify(row?.name)})`,
    )
  }
}

// --- Client manifest ---------------------------------------------------------------------
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be "web"')
const clientExport = pkg.exports?.['./client']
check(typeof clientExport === 'string', 'exports["./client"] must be a plain string path')
check(clientExport === './lib/client.js', 'exports["./client"] must point at the built lib/client.js')

// --- Export resolution -------------------------------------------------------------------
check(pkg.exports?.['./package.json'] === './package.json', 'exports must include "./package.json" for display metadata resolution')
const rootExport = pkg.exports?.['.']
if (typeof rootExport === 'string') {
  check(await exists(rootExport), `exports["."] target is missing: ${rootExport}`)
} else if (rootExport && typeof rootExport === 'object') {
  check(await exists(rootExport.default), `exports["."].default target is missing: ${rootExport.default}`)
  check(await exists(rootExport.types), `exports["."].types target is missing: ${rootExport.types}`)
} else {
  errors.push('exports["."] must name the Host entry')
}
if (typeof clientExport === 'string') {
  check(await exists(clientExport), `exports["./client"] target is missing: ${clientExport} (run npm run build)`)
}
check(pkg.exports?.['./icon'] === './icon.svg', 'exports must include "./icon" as a resource')
for (const localeFile of await readdir(path.join(root, 'locale'))) {
  check(await exists(path.join('locale', localeFile)), `locale file is missing: locale/${localeFile}`)
}

// --- Display resources -------------------------------------------------------------------
const localeDir = path.join(root, 'locale')
const localeFiles = (await readdir(localeDir)).filter((file) => file.endsWith('.json')).sort()
check(localeFiles.includes('en.json'), 'locale/en.json is required for plugin display metadata')
const localeMeta = {}
for (const file of localeFiles) {
  const language = file.slice(0, -'.json'.length)
  let document
  try {
    document = await readJson(path.join('locale', file))
  } catch (error) {
    errors.push(`locale/${file} is not valid JSON: ${error.message}`)
    continue
  }
  const meta = document?.meta
  check(typeof meta?.title === 'string' && meta.title.length > 0, `locale/${file} needs meta.title`)
  check(typeof meta?.description === 'string' && meta.description.length > 0, `locale/${file} needs meta.description`)
  localeMeta[language] = meta
  if (meta?.detail !== undefined) {
    check(typeof meta.detail === 'string' && meta.detail.endsWith('.md'), `locale/${file} meta.detail must name a .md file`)
    if (typeof meta.detail === 'string') {
      check(await exists(meta.detail), `locale/${file} meta.detail file does not exist: ${meta.detail}`)
    }
  }
}
check(Boolean(localeMeta.zh), 'locale/zh.json is expected (the project ships Chinese UI copy)')
if (localeMeta.en && localeMeta.zh) {
  for (const key of Object.keys(localeMeta.en)) {
    check(localeMeta.zh[key] !== undefined, `locale/zh.json must cover meta.${key} declared by en.json`)
  }
}

const iconRelative = typeof pkg.icon === 'string' ? pkg.icon : pkg.exports?.['./icon']
check(typeof iconRelative === 'string' && (await exists(iconRelative)), 'a package icon is required (package.json icon or exports["./icon"])')
if (typeof iconRelative === 'string' && (await exists(iconRelative))) {
  const iconStat = await stat(path.join(root, iconRelative))
  check(iconStat.size <= 256 * 1024, `icon must be at most 256 KiB (got ${iconStat.size} bytes)`)
  const extension = path.extname(iconRelative).toLowerCase()
  check(['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(extension), `icon format is unsupported: ${extension}`)
  if (extension === '.svg') {
    const head = (await readFile(path.join(root, iconRelative), 'utf8')).trimStart()
    check(head.startsWith('<svg') || head.startsWith('<?xml'), 'SVG icon must contain SVG markup')
  }
}

// --- Compatibility against the DSH runtime -------------------------------------------------
// The runtime version is `@deepseek-ai/dsh-app-boot`'s version (app-boot/src/plugin-compatibility.ts).
// Prefer an explicit DSH_VERSION, then a DSH checkout provided by DSH_CHECKOUT or the default path.
async function readCheckoutVersion(checkout) {
  try {
    return JSON.parse(
      await readFile(path.join(checkout, 'packages/boot/app-boot/package.json'), 'utf8'),
    ).version
  } catch {
    return undefined
  }
}
let runtimeVersion = semver.valid(process.env.DSH_VERSION ?? '') ? process.env.DSH_VERSION : undefined
for (const checkout of [
  process.env.DSH_CHECKOUT,
  '/home/leoric/code/deepseek-harness',
].filter(Boolean)) {
  if (runtimeVersion) break
  runtimeVersion = await readCheckoutVersion(checkout)
}
if (runtimeVersion) {
  check(
    semver.satisfies(runtimeVersion, pkg.engines.dsh, { includePrerelease: true }),
    `engines.dsh ${JSON.stringify(pkg.engines.dsh)} does not accept the DSH runtime ${runtimeVersion}`,
  )
} else {
  warnings.push('set DSH_VERSION (or DSH_CHECKOUT) to check engines.dsh against a DSH runtime')
}

// --- npm pack closure --------------------------------------------------------------------
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
)
const packedPaths = new Set((Array.isArray(packed) ? packed[0] : packed)?.files?.map((file) => file.path) ?? [])
check(packedPaths.size > 0, 'npm pack --dry-run returned no files')

const requiredInPack = [
  'package.json',
  'lib/index.js',
  'lib/client.js',
  'lib/types/index.d.ts',
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'README.md',
  'CHANGELOG.md',
  'docs/usage.md',
  'LICENSE',
]
for (const required of requiredInPack) {
  check(packedPaths.has(required), `npm pack closure is missing ${required} (add it to files or exports)`)
}
const forbiddenPrefixes = ['src/', 'tests/', 'scripts/', '.github/', 'node_modules/']
for (const packedPath of packedPaths) {
  for (const prefix of forbiddenPrefixes) {
    if (packedPath.startsWith(prefix)) errors.push(`npm pack closure must not include ${packedPath}`)
    if (prefix === 'node_modules/') continue
  }
  if (packedPath.startsWith('tsconfig') || packedPath.endsWith('.tsbuildinfo') || packedPath.endsWith('.tgz')) {
    errors.push(`npm pack closure must not include ${packedPath}`)
  }
}

// --- Report ------------------------------------------------------------------------------
for (const warning of warnings) console.warn(`validate-package: warning: ${warning}`)
if (errors.length > 0) {
  console.error(`validate-package: ${errors.length} problem(s) across ${checks} checks:`)
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
console.log(
  `validate-package: ${checks} checks passed; ${packedPaths.size} files in the npm tarball` +
    (runtimeVersion ? `; engines.dsh accepts DSH ${runtimeVersion}` : ''),
)
