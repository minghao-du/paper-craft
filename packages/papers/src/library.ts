import { loadCatalog, resolveLibraryContext, syncCatalog } from './catalog.js'
import type { Catalog } from './catalog.js'
import { checkReadableSource, checkSourceRoot, readDocument } from './documents.js'
import { searchPapers } from './search.js'
import type {
  PaperLibraryContext, PaperListOptions, PaperListResult, PaperReadRange, PaperReadResult,
  PaperSearchResult, PaperSummary, PaperSyncResult, SearchScope,
} from './types.js'

function selectedPapers(catalog: Catalog, ids: string[]): PaperSummary[] {
  if (!Array.isArray(ids)) throw new Error('paperIds must be an array of paper IDs')
  const byId = new Map(catalog.papers.map((paper) => [paper.paperId, paper]))
  return [...new Set(ids)].map((id) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Paper IDs must be nonblank strings')
    const paper = byId.get(id)
    if (!paper) throw new Error(`Unknown paper ID: ${id}`)
    return paper
  })
}

function requireAvailable(paper: PaperSummary): void {
  if (paper.availability === 'unavailable') {
    throw new Error(`Paper ${paper.paperId} (${paper.relativePath}) was unavailable at the last synchronization`)
  }
}

function positiveLimit(limit: number, maximum: number, operation: string): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`${operation} limit must be an integer from 1 to ${maximum}`)
  }
}

export class PaperLibrary {
  readonly context: Readonly<PaperLibraryContext>

  constructor(context: PaperLibraryContext) {
    this.context = Object.freeze(resolveLibraryContext(context))
  }

  sync(): PaperSyncResult {
    return syncCatalog(this.context)
  }

  list({ offset = 0, limit = 50 }: PaperListOptions = {}): PaperListResult {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Paper list offset must be a nonnegative integer')
    }
    positiveLimit(limit, 100, 'Paper list')
    const { papers } = getLibrarySnapshot(this)
    const page = papers.slice(offset, offset + limit)
    const next = offset + page.length
    return { papers: page, total: papers.length, nextOffset: next < papers.length ? next : null }
  }

  read(paperId: string, range: PaperReadRange = {}): PaperReadResult {
    const catalog = getLibrarySnapshot(this)
    const [paper] = selectedPapers(catalog, [paperId])
    checkSourceRoot(catalog.sourceRoot)
    requireAvailable(paper)
    try {
      return readDocument(catalog.sourceRoot, paper, range)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Cannot read paper ${paperId} (${paper.relativePath}): ${message}`)
    }
  }

  search(query: string, scope: SearchScope, limit = 10): PaperSearchResult {
    if (typeof query !== 'string' || !query.trim()) throw new Error('Paper search query must be nonblank')
    if (!scope || (scope.kind !== 'all' && scope.kind !== 'papers')) {
      throw new Error('Paper search requires an explicit all or papers scope')
    }
    if (scope.kind === 'all' && 'paperIds' in scope) {
      throw new Error('Use papers scope when supplying paper IDs')
    }
    positiveLimit(limit, 50, 'Paper search')

    const catalog = getLibrarySnapshot(this)
    const papers = scope.kind === 'all' ? catalog.papers : selectedPapers(catalog, scope.paperIds)
    if (papers.length) checkSourceRoot(catalog.sourceRoot)
    const terms = [...new Set(query.trim().toLowerCase().split(/\s+/))]
    return searchPapers(catalog.sourceRoot, papers, terms, limit)
  }
}

export function getLibrarySnapshot(library: PaperLibrary): Catalog {
  return loadCatalog(library.context)
}

export function validateLibraryPapers(library: PaperLibrary, ids: string[], catalog = getLibrarySnapshot(library)): void {
  const papers = selectedPapers(catalog, ids)
  if (papers.length) checkSourceRoot(catalog.sourceRoot)
  for (const paper of papers) {
    requireAvailable(paper)
    try {
      checkReadableSource(catalog.sourceRoot, paper.relativePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Cannot validate new member ${paper.paperId}: ${message}`)
    }
  }
}
