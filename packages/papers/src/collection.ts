import { randomUUID } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalPath, isId } from './catalog.js'
import { getLibrarySnapshot, validateLibraryPapers } from './library.js'
import type { PaperLibrary } from './library.js'

export interface ProjectCollectionContext {
  collectionFile: string
  library: PaperLibrary
}

export interface ProjectCollectionSnapshot {
  libraryId: string
  paperIds: string[]
}

export interface CollectionAddResult {
  addedCount: number
  addedIds: string[]
  alreadyPresentCount: number
  alreadyPresentIds: string[]
}

export interface CollectionRemoveResult {
  removedCount: number
  removedIds: string[]
  alreadyAbsentCount: number
  alreadyAbsentIds: string[]
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function containsPath(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot !== '..' && !fromRoot.startsWith('..' + sep) && !isAbsolute(fromRoot)
}

function readCollection(path: string, libraryId: string): ProjectCollectionSnapshot {
  try {
    if (!lstatSync(path).isFile()) throw new Error(`Collection is not a regular file: ${path}`)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { libraryId, paperIds: [] }
    throw error
  }

  const content = readFileSync(path, 'utf8')
  let state: Record<string, unknown> | null
  try {
    state = JSON.parse(content)
  } catch {
    throw new Error(`Invalid collection JSON: ${path}`)
  }
  if (
    state === null || typeof state !== 'object' || Array.isArray(state)
    || Object.keys(state).length !== 3 || state.schemaVersion !== 1
    || !isId(state.libraryId) || !Array.isArray(state.paperIds)
    || !state.paperIds.every(isId) || new Set(state.paperIds).size !== state.paperIds.length
  ) {
    throw new Error(`Invalid collection schema: ${path}`)
  }
  if (state.libraryId !== libraryId) {
    throw new Error(`Collection library binding mismatch: ${path} belongs to ${state.libraryId}, expected ${libraryId}`)
  }
  return { libraryId, paperIds: state.paperIds }
}

function saveCollection(path: string, state: ProjectCollectionSnapshot): void {
  const temporary = join(dirname(path), `.papers-${randomUUID()}.tmp`)
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    try {
      writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, ...state }, null, 2) + '\n')
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Preserve the write error. The prior collection remains committed.
    }
    throw error
  }
}

export class ProjectCollection {
  private readonly collectionFile: string
  private readonly library: PaperLibrary

  constructor({ collectionFile, library }: ProjectCollectionContext) {
    if (typeof collectionFile !== 'string' || !isAbsolute(collectionFile) || collectionFile.includes('\0')) {
      throw new Error('collectionFile must be an absolute path')
    }
    this.collectionFile = resolve(collectionFile)
    this.library = library
  }

  list(): ProjectCollectionSnapshot {
    return readCollection(this.collectionFile, getLibrarySnapshot(this.library).libraryId)
  }

  add(paperIds: string[]): CollectionAddResult {
    const { changedIds, unchangedIds } = this.change(paperIds, 'add')
    return {
      addedCount: changedIds.length,
      addedIds: changedIds,
      alreadyPresentCount: unchangedIds.length,
      alreadyPresentIds: unchangedIds,
    }
  }

  remove(paperIds: string[]): CollectionRemoveResult {
    const { changedIds, unchangedIds } = this.change(paperIds, 'remove')
    return {
      removedCount: changedIds.length,
      removedIds: changedIds,
      alreadyAbsentCount: unchangedIds.length,
      alreadyAbsentIds: unchangedIds,
    }
  }

  private change(input: string[], operation: 'add' | 'remove') {
    if (!Array.isArray(input) || !Array.from(input).every((id) => typeof id === 'string' && id.trim().length > 0)) {
      throw new Error('paperIds must be an array of nonblank strings')
    }

    const ids = [...new Set(input)]
    const path = join(canonicalPath(dirname(this.collectionFile)), basename(this.collectionFile))
    const beforeLock = getLibrarySnapshot(this.library)
    const current = readCollection(path, beforeLock.libraryId)
    const plan = (state: ProjectCollectionSnapshot) => {
      const existing = new Set(state.paperIds)
      const changedIds: string[] = []
      const unchangedIds: string[] = []
      for (const id of ids) {
        const changesMembership = existing.has(id) === (operation === 'remove')
        const target = changesMembership ? changedIds : unchangedIds
        target.push(id)
      }
      return { changedIds, unchangedIds }
    }

    const initial = plan(current)
    if (initial.changedIds.length === 0) return initial

    const lock = path + '.lock'
    const catalogFile = join(realpathSync(this.library.context.libraryDir), 'catalog.json')
    if (containsPath(beforeLock.sourceRoot, path) || containsPath(beforeLock.sourceRoot, lock)) {
      throw new Error(`Collection writes must be outside the paper source root: ${path}`)
    }
    if (containsPath(catalogFile, path) || containsPath(catalogFile + '.lock', path)) {
      throw new Error(`Collection path conflicts with library storage: ${path}`)
    }

    mkdirSync(dirname(path), { recursive: true })
    let lockDescriptor
    try {
      lockDescriptor = openSync(lock, 'wx', 0o600)
    } catch (error) {
      if (hasCode(error, 'EEXIST')) throw new Error(`Collection is locked: ${lock}`)
      throw error
    }

    try {
      closeSync(lockDescriptor)
      const catalog = getLibrarySnapshot(this.library)
      const state = readCollection(path, catalog.libraryId)
      const result = plan(state)
      if (result.changedIds.length === 0) return result

      if (operation === 'add') {
        validateLibraryPapers(this.library, result.changedIds, catalog)
        state.paperIds = state.paperIds.concat(result.changedIds)
      } else {
        const removed = new Set(result.changedIds)
        state.paperIds = state.paperIds.filter((id) => !removed.has(id))
      }
      saveCollection(path, state)
      return result
    } finally {
      try {
        unlinkSync(lock)
      } catch {
        // A lock cleanup failure cannot undo a committed snapshot.
      }
    }
  }
}
