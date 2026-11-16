export interface PaperLibraryContext {
  sourceRoot: string
  libraryDir: string
}

export interface PaperSummary {
  paperId: string
  relativePath: string
  title: string
  availability: 'available' | 'unavailable'
}

export type SearchScope =
  | { kind: 'all' }
  | { kind: 'papers'; paperIds: string[] }

export interface PaperSyncResult {
  total: number
  added: number
  updated: number
  unavailable: number
  changes: PaperSummary[]
  truncated: boolean
}

export interface PaperListOptions {
  offset?: number
  limit?: number
}

export interface PaperListResult {
  papers: PaperSummary[]
  total: number
  nextOffset: number | null
}

export interface PaperReadRange {
  startLine?: number
  endLine?: number
}

export interface PaperReadResult {
  paperId: string
  relativePath: string
  title: string
  text: string
  startLine: number
  endLine: number
  nextLine: number | null
}

export interface PaperExcerpt {
  text: string
  startLine: number
  endLine: number
  truncated: boolean
}

export interface PaperHit {
  paperId: string
  relativePath: string
  title: string
  excerpts: PaperExcerpt[]
}

export interface PaperSearchDiagnostic {
  paperId: string
  relativePath: string
  message: string
}

export interface PaperSearchResult {
  hits: PaperHit[]
  coverage: 'complete' | 'partial' | 'none'
  requested: number
  read: number
  skipped: number
  diagnosticCount: number
  diagnostics: PaperSearchDiagnostic[]
  truncated: boolean
}
