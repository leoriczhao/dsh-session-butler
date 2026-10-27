/**
 * Locate one session's on-disk directory under the DSH sessions root.
 *
 * Session ids are the authority, not directory names: the corpus contains both
 * `session-<uuid>` and bare `<uuid>` ids, and the directory normally mirrors the
 * id. The locator therefore builds a name index once per operation, tries the
 * exact id first, then the historical `session-` prefix variants, and verifies
 * candidates through the stored v4 header whenever the bytes are readable.
 *
 * @module dsh-session-butler/host/locate
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { ButlerError } from '../shared/errors.js'
import { exists } from './fs.js'
import type { SessionHeaderLike, SessionRecordLike } from './ports.js'

/** The session log file name of the current v4 JSONL format. */
const SESSION_LOG_FILE = 'session.v4.jsonl.zstd'

/** One resolved session directory plus its identity. */
export interface LocatedSession {
  readonly id: string
  readonly header: SessionHeaderLike
  readonly formatStatus?: 'current' | 'migration-required'
  /** Escaped project directory name under the sessions root. */
  readonly projectDir: string
  /** Session directory name; normally equal to the id. */
  readonly dirName: string
  /** Absolute session directory. */
  readonly absolutePath: string
}

/** Candidate directory names for one session id, most likely first. */
function candidateNames(id: string): string[] {
  const names = [id]
  if (id.startsWith('session-')) {
    names.push(`session-${id}`)
    const bare = id.slice('session-'.length)
    if (bare.length > 0) names.push(bare)
  } else {
    names.push(`session-${id}`)
  }
  return [...new Set(names)]
}

/** Read the stored v4 header id from a session directory, or undefined when unreadable. */
async function readHeaderId(sessionDirectory: string): Promise<string | undefined> {
  try {
    const compressed = await readFile(path.join(sessionDirectory, SESSION_LOG_FILE))
    const firstLine = zstdDecompressSync(compressed).toString('utf8').split('\n', 1)[0]
    const parsed = JSON.parse(firstLine ?? '') as { type?: unknown; id?: unknown }
    return parsed.type === 'session' && typeof parsed.id === 'string' ? parsed.id : undefined
  } catch {
    return undefined
  }
}

/** Whether `child` is `parent` or lives inside it (both absolute, normalized). */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Resolve session records to their directories. One locator instance is bound
 * to one sessions root and is cheap; each `locateAll` call re-reads the index so
 * a concurrent writer cannot leave it stale across operations.
 */
export class SessionLocator {
  constructor(readonly sessionsRoot: string) {}

  /**
   * Resolve every record in the batch, or fail without deleting anything.
   * @param records - session records (root plus optional cascade descendants).
   * @returns one resolved directory per record, in input order.
   * @throws {ButlerError} `session-unresolved-path` for a missing, ambiguous or
   *   outside-root directory, or `unsupported` when the sessions root is absent.
   */
  async locateAll(records: readonly SessionRecordLike[]): Promise<LocatedSession[]> {
    const rootReal = await this.resolveRoot()
    const index = await this.buildIndex(rootReal)
    const located: LocatedSession[] = []
    for (const record of records) {
      located.push(await this.locateOne(record, index, rootReal))
    }
    return located
  }

  private async resolveRoot(): Promise<string> {
    try {
      const info = await stat(this.sessionsRoot)
      if (!info.isDirectory()) throw new Error('not a directory')
      return await realpath(this.sessionsRoot)
    } catch (error) {
      throw new ButlerError('unsupported', `sessions root is unavailable: ${this.sessionsRoot}`, {
        cause: error,
      })
    }
  }

  /** Directory-name → absolute paths, across every project directory. */
  private async buildIndex(rootReal: string): Promise<Map<string, string[]>> {
    const index = new Map<string, string[]>()
    const projects = await readdir(this.sessionsRoot, { withFileTypes: true })
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue
      const projectDirectory = path.join(this.sessionsRoot, project.name)
      let entries
      try {
        entries = await readdir(projectDirectory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const absolutePath = path.join(projectDirectory, entry.name)
        const known = index.get(entry.name) ?? []
        known.push(absolutePath)
        index.set(entry.name, known)
      }
    }
    void rootReal
    return index
  }

  private async locateOne(
    record: SessionRecordLike,
    index: ReadonlyMap<string, string[]>,
    rootReal: string,
  ): Promise<LocatedSession> {
    const id = record.header.id
    const matches: Array<{ absolutePath: string; projectDir: string; dirName: string }> = []
    for (const name of candidateNames(id)) {
      for (const absolutePath of index.get(name) ?? []) {
        const directory = path.dirname(absolutePath)
        const projectDir = path.basename(directory)
        if (!(await exists(path.join(absolutePath, SESSION_LOG_FILE)))) continue
        let directoryReal: string
        try {
          directoryReal = await realpath(absolutePath)
        } catch {
          continue
        }
        if (!isInside(rootReal, directoryReal)) continue
        if (name !== id) {
          const storedId = await readHeaderId(absolutePath)
          if (storedId !== id) continue
        } else {
          const storedId = await readHeaderId(absolutePath)
          if (storedId !== undefined && storedId !== id) continue
        }
        matches.push({ absolutePath, projectDir, dirName: name })
      }
      if (matches.length > 0) break
    }
    if (matches.length === 0) {
      throw new ButlerError('session-unresolved-path', `session directory not found for "${id}"`, {
        details: { sessionId: id },
      })
    }
    if (matches.length > 1) {
      throw new ButlerError('session-unresolved-path', `session directory is ambiguous for "${id}"`, {
        details: { sessionId: id, candidates: matches.map(match => match.absolutePath) },
      })
    }
    const match = matches[0]
    if (match === undefined) throw new ButlerError('internal', `unreachable: no match for "${id}"`)
    return {
      id,
      header: record.header,
      ...(record.formatStatus === undefined ? {} : { formatStatus: record.formatStatus }),
      projectDir: match.projectDir,
      dirName: match.dirName,
      absolutePath: match.absolutePath,
    }
  }
}
