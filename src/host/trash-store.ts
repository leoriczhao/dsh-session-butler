/**
 * Trash storage layout.
 *
 * The trash mirrors the sessions tree, so a trashed session keeps its identity
 * and its restore destination without a separate index:
 *
 * ```
 * <trashRoot>/<project>/<sessionDir>/          moved session directory
 * <trashRoot>/<project>/<sessionDir>.json      deletion metadata
 * ```
 *
 * Metadata is written after the move (temp file + rename). A crash between the
 * two leaves a directory without metadata, which `list` reports as an orphan
 * instead of silently guessing; restore/purge refuse non-entry paths.
 *
 * @module dsh-session-butler/host/trash-store
 */

import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { ButlerError } from '../shared/errors.js'
import {
  exists,
  moveDirectory,
  removeDirectory,
  removeEmptyDirectory,
  readJson,
  writeJsonAtomic,
} from './fs.js'
import type { LocatedSession } from './locate.js'
import type { SessionHeaderLike } from './ports.js'

/** Current metadata format version. */
const TRASH_META_VERSION = 1

/** One trashed session's durable metadata. */
export interface TrashMeta {
  readonly version: typeof TRASH_META_VERSION
  readonly id: string
  /** Escaped project directory name the session came from. */
  readonly originalProject: string
  /** Session directory name it came from. */
  readonly originalDir: string
  /** Unix epoch ms when the entry entered the trash. */
  readonly deletedAt: number
  /** Header snapshot at deletion time. */
  readonly header: SessionHeaderLike
  /** Parent session id when this entry was cascaded from another deletion. */
  readonly cascadeOf?: string
  /** Ids cascaded with this root (empty on descendant entries). */
  readonly descendants: readonly string[]
}

/** One valid trash entry with its locations. */
export interface TrashEntry {
  readonly meta: TrashMeta
  /** Escaped project directory name inside the trash root. */
  readonly projectDir: string
  /** Session directory name inside the trash root. */
  readonly dirName: string
  readonly trashPath: string
  readonly metaPath: string
}

/** Trash directory listing with the paths that could not be parsed. */
export interface TrashListing {
  readonly entries: TrashEntry[]
  readonly orphans: Array<{ path: string; reason: string }>
}

/** Whether `value` is a single safe path segment. */
function isSegment(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !path.isAbsolute(value)
}

/** Validate one stored metadata document. */
function parseMeta(value: unknown, metaPath: string): TrashMeta {
  const record = value as Partial<TrashMeta> | undefined
  if (typeof record !== 'object' || record === null) throw new Error('metadata is not an object')
  if (record.version !== TRASH_META_VERSION) throw new Error(`unsupported metadata version: ${String(record.version)}`)
  if (!isSegment(record.id)) throw new Error('invalid session id')
  if (!isSegment(record.originalProject)) throw new Error('invalid original project')
  if (!isSegment(record.originalDir)) throw new Error('invalid original directory')
  if (typeof record.deletedAt !== 'number' || !Number.isFinite(record.deletedAt)) throw new Error('invalid deletedAt')
  const header = record.header as SessionHeaderLike | undefined
  if (typeof header !== 'object' || header === null || typeof header.id !== 'string') throw new Error('invalid header snapshot')
  if (header.id !== record.id) throw new Error('header id does not match metadata id')
  const descendants = record.descendants === undefined ? [] : record.descendants
  if (!Array.isArray(descendants) || descendants.some(entry => typeof entry !== 'string')) {
    throw new Error('invalid descendants list')
  }
  if (record.cascadeOf !== undefined && typeof record.cascadeOf !== 'string') throw new Error('invalid cascadeOf')
  void metaPath
  return {
    version: TRASH_META_VERSION,
    id: record.id,
    originalProject: record.originalProject,
    originalDir: record.originalDir,
    deletedAt: record.deletedAt,
    header,
    ...(record.cascadeOf === undefined ? {} : { cascadeOf: record.cascadeOf }),
    descendants,
  }
}

/** Read-only view over one trash root; all mutations go through explicit methods. */
export class TrashStore {
  constructor(
    readonly sessionsRoot: string,
    readonly trashRoot: string,
  ) {}

  /** List valid entries plus unparsable leftovers. */
  async list(): Promise<TrashListing> {
    const entries: TrashEntry[] = []
    const orphans: Array<{ path: string; reason: string }> = []
    let projects
    try {
      projects = await readdir(this.trashRoot, { withFileTypes: true })
    } catch {
      return { entries, orphans }
    }
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue
      const projectDir = path.join(this.trashRoot, project.name)
      let children
      try {
        children = await readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      const directories = new Set(children.filter(child => child.isDirectory() && !child.isSymbolicLink()).map(child => child.name))
      for (const child of children) {
        if (!child.isFile() || !child.name.endsWith('.json')) continue
        const dirName = child.name.slice(0, -'.json'.length)
        const metaPath = path.join(projectDir, child.name)
        let meta: TrashMeta
        try {
          const stored = await readJson<unknown>(metaPath)
          if (stored === undefined) throw new Error('metadata disappeared')
          meta = parseMeta(stored, metaPath)
        } catch (error) {
          orphans.push({ path: metaPath, reason: error instanceof Error ? error.message : String(error) })
          continue
        }
        if (!directories.has(dirName)) {
          orphans.push({ path: metaPath, reason: 'session directory is missing' })
          continue
        }
        entries.push({
          meta,
          projectDir: project.name,
          dirName,
          trashPath: path.join(projectDir, dirName),
          metaPath,
        })
      }
      for (const dirName of directories) {
        if (!children.some(child => child.isFile() && child.name === `${dirName}.json`)) {
          orphans.push({ path: path.join(projectDir, dirName), reason: 'metadata is missing' })
        }
      }
    }
    entries.sort((left, right) => right.meta.deletedAt - left.meta.deletedAt)
    return { entries, orphans }
  }

  /** Find one entry by session id, or undefined when the trash holds none. */
  async find(id: string): Promise<TrashEntry | undefined> {
    const { entries } = await this.list()
    return entries.find(entry => entry.meta.id === id)
  }

  /** Fail before any move when the trash destination for one session is occupied. */
  async assertFree(located: LocatedSession): Promise<void> {
    const trashPath = path.join(this.trashRoot, located.projectDir, located.dirName)
    if (await exists(trashPath) || await exists(`${trashPath}.json`)) {
      throw new ButlerError('trash-conflict', `trash already holds "${located.id}"`, {
        details: { sessionId: located.id, path: trashPath },
      })
    }
  }

  /**
   * Move one located session into the trash and write its metadata.
   * @throws {ButlerError} `trash-conflict` when the destination is occupied,
   *   `internal` when metadata cannot be written (the move is rolled back).
   */
  async moveIn(
    located: LocatedSession,
    info: { deletedAt: number; cascadeOf?: string; descendants?: readonly string[] },
  ): Promise<TrashEntry> {
    const projectDirectory = path.join(this.trashRoot, located.projectDir)
    const trashPath = path.join(projectDirectory, located.dirName)
    const metaPath = `${trashPath}.json`
    if (await exists(trashPath) || await exists(metaPath)) {
      throw new ButlerError('trash-conflict', `trash already holds "${located.id}"`, {
        details: { sessionId: located.id, path: trashPath },
      })
    }
    const meta: TrashMeta = {
      version: TRASH_META_VERSION,
      id: located.id,
      originalProject: located.projectDir,
      originalDir: located.dirName,
      deletedAt: info.deletedAt,
      header: located.header,
      ...(info.cascadeOf === undefined ? {} : { cascadeOf: info.cascadeOf }),
      descendants: info.descendants ?? [],
    }
    try {
      await moveDirectory(located.absolutePath, trashPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        throw new ButlerError('session-cross-device', `cannot move "${located.id}" to the trash: cross-device move`, {
          details: { sessionId: located.id },
          cause: error,
        })
      }
      throw new ButlerError('internal', `failed to move "${located.id}" to the trash`, {
        details: { sessionId: located.id },
        cause: error,
      })
    }
    try {
      await writeJsonAtomic(metaPath, meta)
    } catch (error) {
      try {
        await moveDirectory(trashPath, located.absolutePath)
      } catch {
        // The directory stays in the trash without metadata; list() reports it as an orphan.
      }
      throw new ButlerError('internal', `failed to write trash metadata for "${located.id}"`, {
        details: { sessionId: located.id },
        cause: error,
      })
    }
    return { meta, projectDir: located.projectDir, dirName: located.dirName, trashPath, metaPath }
  }

  /**
   * Move one entry back to its original sessions directory.
   * @throws {ButlerError} `trash-conflict` when the original path is occupied.
   */
  async moveOut(entry: TrashEntry): Promise<string> {
    const destination = path.join(
      this.sessionsRoot,
      entry.meta.originalProject,
      entry.meta.originalDir,
    )
    if (await exists(destination)) {
      throw new ButlerError('trash-conflict', `original session path is occupied: ${destination}`, {
        details: { sessionId: entry.meta.id },
      })
    }
    await moveDirectory(entry.trashPath, destination)
    await rm(entry.metaPath, { force: true })
    await removeEmptyDirectory(path.join(this.trashRoot, entry.meta.originalProject))
    return destination
  }

  /** Permanently remove one entry's directory and metadata. */
  async purge(entry: TrashEntry): Promise<void> {
    await removeDirectory(entry.trashPath)
    await rm(entry.metaPath, { force: true })
    await removeEmptyDirectory(path.join(this.trashRoot, entry.meta.originalProject))
  }
}
