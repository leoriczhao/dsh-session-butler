/**
 * Small filesystem helpers for the trash pipeline.
 *
 * The pipeline needs only four primitives: existence, directory moves, atomic
 * metadata writes and guarded removal. Keeping them here (instead of using a
 * general-purpose fs wrapper) makes the delete path auditable.
 *
 * @module dsh-session-butler/host/fs
 */

import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Whether `target` exists. */
export async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** Read one JSON document, or `undefined` when the file is absent. */
export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Write one JSON document via temp file + rename so readers never see a partial one. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * Move one directory. Cross-device moves are refused rather than copied: a copy
 * would leave two sources of truth for the same session.
 */
export async function moveDirectory(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EXDEV') {
      throw Object.assign(new Error(`cannot move ${from} to ${to}: cross-device move`), { code: 'EXDEV' })
    }
    throw error
  }
}

/** Remove one directory tree. */
export async function removeDirectory(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true })
}

/** Remove a now-empty project directory; ignore a non-empty or absent one. */
export async function removeEmptyDirectory(target: string): Promise<void> {
  try {
    await rmdir(target)
  } catch {
    // Not empty, absent, or already removed: all fine for a best-effort cleanup.
  }
}
