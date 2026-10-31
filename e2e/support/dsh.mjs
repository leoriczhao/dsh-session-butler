/**
 * E2E support: a disposable DSH_HOME with this checkout packed by npm and
 * unpacked into a profile, plus the real `dsh web` process the two E2E lanes
 * drive.
 *
 * The fixture never touches the user's own DSH home: every run creates a
 * temporary directory, writes a two-workspace profile, installs the packed
 * publishable artifact, boots the real CLI from this repository's
 * devDependency, and removes the directory afterwards.
 */
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const DSH_BIN = join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
export const PACKAGE_JSON = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'))

const DEFAULT_WORKSPACES = ['alpha', 'beta']

/** Poll an async probe until it returns a truthy value. */
export async function waitFor(probe, { timeout = 20_000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Build the profile package.json this fixture writes into a fresh DSH home. */
function profileManifest(pluginSpec) {
  return {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-session-butler': pluginSpec },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-session-butler'],
      },
    },
  }
}

const execFileAsync = promisify(execFile)

/**
 * Pack this checkout with npm's own `files` allowlist and unpack it into the
 * profile the same way a registry install would. The E2E lanes therefore run
 * the publishable artifact, not the source tree behind a symlink.
 */
async function installPackedPlugin(home, profileDir) {
  try {
    await access(join(REPO_ROOT, 'lib', 'client.js'))
  } catch {
    throw new Error('E2E needs the built artifacts; run "pnpm run build" (or "pnpm run verify") first')
  }
  const { stdout } = await execFileAsync('npm', ['pack', '--ignore-scripts', '--pack-destination', home], {
    cwd: REPO_ROOT,
    maxBuffer: 4 * 1024 * 1024,
  })
  const filename = stdout.trim().split('\n').at(-1)
  if (filename === undefined || !filename.endsWith('.tgz')) {
    throw new Error(`npm pack did not report a tarball: ${JSON.stringify(stdout)}`)
  }
  const tarball = join(home, filename)
  const target = join(profileDir, 'node_modules', 'dsh-session-butler')
  await mkdir(target, { recursive: true })
  await execFileAsync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'])
  return `file:${tarball}`
}

/** Encode one path component the way the JSONL session store encodes ids. */
function encodeSegment(raw) {
  return raw.replace(/[^A-Za-z0-9._-]/g, character =>
    '~' + character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
}

/** Human-readable project directory key; matches the JSONL store's projectKey. */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (const character of cwd) {
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character === '~' || !/^[A-Za-z0-9._-]$/.test(character)) {
      readable += '~' + character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    } else {
      readable += character
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Write one idle, non-blank persisted Session in the real JSONL v4 format.
 * The first zstd frame must contain only the header line; the remaining events
 * live in their own frame, exactly as the DSH persistence backend expects.
 */
async function writeSeededSession(home, { id, cwd, title }) {
  const now = Date.now()
  const messageId = randomUUID()
  const header = {
    type: 'session', version: 4, id, createdAt: now, cwd, isSeeded: false,
    delegationDepth: 0, agentPreset: 'standard',
  }
  const events = [
    { type: 'permission/preset', seq: 0, time: now, data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', seq: 1, time: now, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', seq: 2, time: now, data: { policy: 'ask' } },
    { type: 'session/end-seed', seq: 3, time: now, data: {} },
    {
      type: 'user/message', seq: 4, time: now,
      data: {
        content: [{ type: 'text', text: title }],
        source: { kind: 'user', rpcId: randomUUID() },
        role: 'user', id: messageId,
      },
      surfaceOp: 'append',
    },
    { type: 'session/title', seq: 5, time: now, data: { title, messageSeqs: [4], source: { kind: 'fallback' } } },
  ]
  const dir = join(home, 'sessions', projectKey(cwd), encodeSegment(id))
  await mkdir(dir, { recursive: true })
  const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'))
  const eventFrame = zstdCompressSync(Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n'))
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([headerFrame, eventFrame]))
}

/** Seed workspaces, optionally with persisted non-blank sessions, before boot. */
async function seedWorkspaceStore(home, workspaces, sessions) {
  const now = new Date().toISOString()
  const ids = workspaces.map(name => `ws-e2e-${name}`)
  const tables = {}
  for (const [index, name] of workspaces.entries()) {
    tables[ids[index]] = {
      path: join(home, `project-${name}`),
      title: name,
      sessionIds: sessions.filter(session => session.workspace === name).map(session => session.id),
      createdAt: now,
      updatedAt: now,
    }
    await mkdir(join(home, `project-${name}`), { recursive: true })
  }
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ids,
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: { workspaces: tables },
  }, null, 2))
}

/**
 * Create a disposable DSH home with this checkout symlinked as a Web profile
 * plugin.
 * @returns {{ home: string, workspaces: readonly string[], cleanup: () => Promise<void> }}
 */
export async function createDshHome({ workspaces = DEFAULT_WORKSPACES, seedSessions = [] } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-butler-e2e-'))
  const profileDir = join(home, 'profiles', 'web')
  const modulesDir = join(profileDir, 'node_modules')
  await mkdir(modulesDir, { recursive: true })
  const pluginSpec = await installPackedPlugin(home, profileDir)
  await writeFile(join(profileDir, 'package.json'), JSON.stringify(profileManifest(pluginSpec), null, 2))
  await mkdir(join(home, 'sessions'), { recursive: true })

  const sessions = seedSessions.map((entry, index) => {
    if (!workspaces.includes(entry.workspace)) {
      throw new Error(`seed session workspace "${entry.workspace}" is not one of ${JSON.stringify(workspaces)}`)
    }
    return {
      id: entry.id ?? `session-e2e-${String(index + 1).padStart(2, '0')}-${randomUUID()}`,
      workspace: entry.workspace,
      title: entry.title ?? `E2E seeded ${entry.workspace} chat`,
      cwd: join(home, `project-${entry.workspace}`),
    }
  })
  for (const session of sessions) await writeSeededSession(home, session)
  await seedWorkspaceStore(home, workspaces, sessions)
  return {
    home,
    workspaces,
    sessions,
    async cleanup() { await rm(home, { recursive: true, force: true }) },
  }
}

/**
 * Start the real `dsh web` CLI against a disposable home.
 * @returns the printed URL plus teardown and captured output.
 */
export async function startDshWeb(home, { timeout = 45_000 } = {}) {
  const child = spawn(process.execPath, [DSH_BIN, 'web', '--no-open', '--port', '0'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })

  const exited = new Promise(resolve => child.once('exit', code => resolve(code)))
  let settled = false
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`dsh web did not print a URL within ${timeout}ms\n${stdout}\n${stderr}`)), timeout)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    child.stdout.on('data', () => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
      if (match) finish(undefined, match[0])
    })
    child.once('exit', code => finish(new Error(`dsh web exited with code ${String(code)}\n${stdout}\n${stderr}`)))
  })

  const parsed = new URL(url)
  const origin = parsed.origin
  let stopped = false
  return {
    child,
    url,
    origin,
    token: parsed.searchParams.get('token'),
    get stdout() { return stdout },
    get stderr() { return stderr },
    async stop() {
      if (stopped) return
      stopped = true
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      const result = await Promise.race([
        exited.then(() => 'exited'),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000)),
      ])
      if (result === 'timeout' && child.exitCode === null) child.kill('SIGKILL')
      await exited.catch(() => {})
    },
  }
}

/**
 * Open the printed Web URL once, capture the browser-auth cookie, and read the
 * authenticated index HTML. This mirrors what a browser does before the page
 * boots without requiring a browser.
 */
export async function authenticateWeb(url) {
  const entry = await fetch(url, { redirect: 'manual' })
  const setCookie = entry.headers.getSetCookie?.()[0] ?? entry.headers.get('set-cookie')
  if (!setCookie) throw new Error(`dsh web did not set a browser-auth cookie (status ${entry.status})`)
  const cookie = setCookie.split(';', 1)[0]
  const location = new URL(entry.headers.get('location') ?? '/', url)
  const page = await fetch(location, { headers: { cookie }, redirect: 'manual' })
  if (page.status !== 200) throw new Error(`authenticated index answered ${page.status}`)
  return { cookie, html: await page.text(), indexUrl: location.href }
}

/** POST one Threadloom bridge method with the captured browser cookie. */
export async function callBridge(origin, cookie, method, body = {}) {
  const response = await fetch(`${origin}/session-butler/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
