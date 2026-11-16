import { randomUUID } from 'node:crypto'
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { titleOf, readSource, checkSourceRoot } from './documents.js'
import type { PaperLibraryContext, PaperSummary, PaperSyncResult } from './types.js'

export interface Catalog {
  schemaVersion: 1
  libraryId: string
  sourceRoot: string
  papers: PaperSummary[]
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)
}

function isPaperPath(value: unknown): value is string {
  return typeof value === 'string'
    && !value.includes('\0')
    && (sep !== '\\' || (!value.includes('\\') && !value.includes(':')))
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    && extname(value).toLowerCase() === '.md'
}

function isPaper(value: unknown): value is PaperSummary {
  return isRecord(value)
    && isId(value.paperId)
    && isPaperPath(value.relativePath)
    && typeof value.title === 'string'
    && (value.availability === 'available' || value.availability === 'unavailable')
}

// Resolve existing ancestors even when a catalog or source directory is temporarily absent.
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(canonicalPath(parent), relative(parent, path))
  }
}

export function resolveLibraryContext(context: PaperLibraryContext): PaperLibraryContext {
  for (const path of [context.sourceRoot, context.libraryDir]) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
      throw new Error('sourceRoot and libraryDir must be absolute paths')
    }
  }

  // Existing roots are bound by their real paths. Retain the lexical path for a missing root.
  const sourceRoot = canonicalPath(resolve(context.sourceRoot))
  const libraryDir = canonicalPath(resolve(context.libraryDir))
  return { sourceRoot, libraryDir }
}

function readCatalog(context: PaperLibraryContext, allowMissing: false): Catalog
function readCatalog(context: PaperLibraryContext, allowMissing: true): Catalog | undefined
function readCatalog(context: PaperLibraryContext, allowMissing: boolean): Catalog | undefined {
  const path = join(context.libraryDir, 'catalog.json')
  let contents: string
  try {
    if (!lstatSync(path).isFile()) throw new Error('Expected a regular catalog file')
    contents = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      if (allowMissing) return undefined
      throw new Error(`Paper catalog is missing at ${path}; synchronize the library first`)
    }
    throw new Error(`Cannot read paper catalog at ${path}: ${errorMessage(error)}`)
  }

  let data: unknown
  try {
    data = JSON.parse(contents)
  } catch {
    throw new Error(`Invalid JSON in paper catalog at ${path}`)
  }

  if (!isRecord(data)
    || data.schemaVersion !== 1
    || !isId(data.libraryId)
    || typeof data.sourceRoot !== 'string'
    || !isAbsolute(data.sourceRoot)
    || data.sourceRoot.includes('\0')
    || resolve(data.sourceRoot) !== data.sourceRoot
    || !Array.isArray(data.papers)) {
    throw new Error(`Invalid paper catalog schema at ${path}`)
  }

  const ids = new Set<string>()
  const paths = new Set<string>()
  const papers: PaperSummary[] = []
  for (const paper of data.papers as unknown[]) {
    if (!isPaper(paper) || ids.has(paper.paperId) || paths.has(paper.relativePath)) {
      throw new Error(`Invalid or duplicate paper record in catalog at ${path}`)
    }
    ids.add(paper.paperId)
    paths.add(paper.relativePath)
    papers.push({
      paperId: paper.paperId,
      relativePath: paper.relativePath,
      title: paper.title,
      availability: paper.availability,
    })
  }

  if (data.sourceRoot !== context.sourceRoot) {
    throw new Error(`Paper catalog at ${path} is bound to ${data.sourceRoot}, not ${context.sourceRoot}`)
  }
  return { schemaVersion: 1, libraryId: data.libraryId, sourceRoot: data.sourceRoot, papers }
}

export function loadCatalog(context: PaperLibraryContext): Catalog {
  return readCatalog(context, false)
}

function discoverTitles(root: string): Map<string, string> {
  checkSourceRoot(root)
  const directories = ['']
  const titles = new Map<string, string>()

  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index]
    const absoluteDirectory = join(root, directory)
    try {
      if (!lstatSync(absoluteDirectory).isDirectory() || realpathSync(absoluteDirectory) !== absoluteDirectory) {
        throw new Error('Directory changed during synchronization')
      }

      for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
        const path = directory ? `${directory}/${entry.name}` : entry.name
        if (entry.isDirectory()) directories.push(path)
        if (entry.isFile() && isPaperPath(path)) {
          titles.set(path, titleOf(readSource(root, path), path))
        }
      }
    } catch (error) {
      throw new Error(`Cannot synchronize paper sources in ${absoluteDirectory}: ${errorMessage(error)}`)
    }
  }

  // A source observed early in the traversal can disappear while later directories are being scanned.
  for (const path of [...directories, ...titles.keys()]) {
    const absolutePath = join(root, path)
    try {
      const stat = lstatSync(absolutePath)
      const expectedKind = titles.has(path) ? stat.isFile() : stat.isDirectory()
      if (!expectedKind || realpathSync(absolutePath) !== absolutePath) throw new Error('Source path changed')
    } catch (error) {
      throw new Error(`Cannot complete paper synchronization at ${absolutePath}: ${errorMessage(error)}`)
    }
  }
  return titles
}

function saveCatalog(directory: string, catalog: Catalog): void {
  const temporaryPath = join(directory, `.catalog-${randomUUID()}.tmp`)
  const fd = openSync(temporaryPath, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(catalog, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporaryPath, join(directory, 'catalog.json'))
  } catch (error) {
    unlinkSync(temporaryPath)
    throw error
  }
}

export function syncCatalog(context: PaperLibraryContext): PaperSyncResult {
  checkSourceRoot(context.sourceRoot)
  const directory = canonicalPath(context.libraryDir)
  const fromSource = relative(context.sourceRoot, directory)
  if (fromSource === '' || (!isAbsolute(fromSource) && fromSource !== '..' && !fromSource.startsWith(`..${sep}`))) {
    throw new Error(`Library data directory must be outside the paper source root: ${directory}`)
  }

  mkdirSync(directory, { recursive: true })
  const lock = join(directory, 'catalog.json.lock')
  try {
    mkdirSync(lock)
  } catch (error) {
    if (hasCode(error, 'EEXIST')) throw new Error(`Paper catalog is locked at ${lock}`)
    throw error
  }

  try {
    const previous = readCatalog(context, true)
    const titles = discoverTitles(context.sourceRoot)
    const existing = new Map(previous?.papers.map((paper) => [paper.relativePath, paper]))
    const paths = [...new Set([...existing.keys(), ...titles.keys()])].sort()
    const changes: PaperSummary[] = []
    let changesBytes = 0
    let added = 0
    let updated = 0
    let unavailable = 0

    const papers = paths.map((relativePath): PaperSummary => {
      const before = existing.get(relativePath)
      const title = titles.get(relativePath)
      const paper: PaperSummary = {
        paperId: before?.paperId ?? randomUUID(),
        relativePath,
        title: title ?? before?.title ?? '',
        availability: title === undefined ? 'unavailable' : 'available',
      }
      if (!before) added++
      else if (before.availability === 'available' && paper.availability === 'unavailable') unavailable++
      else if (before.title !== paper.title || before.availability !== paper.availability) updated++
      else return paper

      if (changes.length < 20) {
        const bytes = Buffer.byteLength(JSON.stringify(paper))
        if (changesBytes + bytes <= 32_768) {
          changes.push(paper)
          changesBytes += bytes
        }
      }
      return paper
    })

    const result: PaperSyncResult = {
      total: papers.length,
      added,
      updated,
      unavailable,
      changes,
      truncated: changes.length < added + updated + unavailable,
    }
    if (!previous || added + updated + unavailable > 0) {
      saveCatalog(directory, {
        schemaVersion: 1,
        libraryId: previous?.libraryId ?? randomUUID(),
        sourceRoot: context.sourceRoot,
        papers,
      })
    }
    return result
  } finally {
    rmdirSync(lock)
  }
}
