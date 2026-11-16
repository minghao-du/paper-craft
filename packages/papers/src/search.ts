import { loadDocument } from './documents.js'
import type { Document, SourceBlock } from './documents.js'
import type { PaperExcerpt, PaperHit, PaperSearchResult, PaperSummary } from './types.js'

const MAX_EXCERPTS = 3
const MAX_EXCERPT_CHARS = 1000
const MAX_SEARCH_CHARS = 12_000
const MAX_DIAGNOSTICS = 10

interface Match {
  block: SourceBlock
  score: number
  matchOffset: number
}

interface RankedPaper {
  hit: PaperHit
  score: number
  titleScore: number
  omittedMatches: boolean
}

function sourceOffset(text: string, foldedOffset: number): number {
  if (text.length === text.toLowerCase().length) return foldedOffset
  // Case conversion can expand characters such as İ. Map the folded offset back to the source.
  let consumed = 0
  let offset = 0
  for (const character of text) {
    consumed += character.toLowerCase().length
    if (consumed > foldedOffset) return offset
    offset += character.length
  }
  return offset
}

function lineAt(document: Document, offset: number, block: SourceBlock): number {
  let first = block.startLine
  let last = block.endLine
  while (first < last) {
    const middle = Math.ceil((first + last) / 2)
    if (document.lines[middle - 1].start <= offset) first = middle
    else last = middle - 1
  }
  return first
}

function excerpt(document: Document, match: Match): PaperExcerpt {
  const { block, matchOffset } = match
  const blockStart = document.lines[block.startLine - 1].start
  const blockEnd = document.lines[block.endLine - 1].end
  const truncated = blockEnd - blockStart > MAX_EXCERPT_CHARS
  let start = blockStart
  let end = blockEnd
  if (truncated) {
    start = Math.min(blockEnd - MAX_EXCERPT_CHARS,
      Math.max(blockStart, blockStart + matchOffset - Math.floor(MAX_EXCERPT_CHARS / 3)))
    end = start + MAX_EXCERPT_CHARS
    // Keep complete Unicode characters at both excerpt boundaries.
    if (/[\uDC00-\uDFFF]/.test(document.text[start])) start++
    if (/[\uD800-\uDBFF]/.test(document.text[end - 1])) end--
  }
  return {
    text: document.text.slice(start, end),
    startLine: lineAt(document, start, block),
    endLine: lineAt(document, end - 1, block),
    truncated,
  }
}

function rankPaper(document: Document, paper: PaperSummary, terms: string[]): RankedPaper | undefined {
  const matches: Match[] = []
  for (const block of document.blocks) {
    const start = document.lines[block.startLine - 1].start
    const end = document.lines[block.endLine - 1].end
    const text = document.searchableText.slice(start, end)
    const folded = text.toLowerCase()
    let score = 0
    let firstMatch = Infinity
    for (const term of terms) {
      const position = folded.indexOf(term)
      if (position !== -1) {
        score++
        firstMatch = Math.min(firstMatch, position)
      }
    }
    if (score) matches.push({ block, score, matchOffset: sourceOffset(text, firstMatch) })
  }
  if (!matches.length) return undefined

  matches.sort((left, right) => right.score - left.score || left.block.startLine - right.block.startLine)
  const title = document.title.toLowerCase()
  return {
    hit: {
      paperId: paper.paperId,
      relativePath: paper.relativePath,
      title: document.title,
      excerpts: matches.slice(0, MAX_EXCERPTS).map((match) => excerpt(document, match)),
    },
    score: matches[0].score,
    titleScore: terms.filter((term) => title.includes(term)).length,
    omittedMatches: matches.length > MAX_EXCERPTS,
  }
}

export function searchPapers(
  root: string, papers: PaperSummary[], terms: string[], limit: number,
): PaperSearchResult {
  const ranked: RankedPaper[] = []
  const diagnostics: PaperSearchResult['diagnostics'] = []
  let read = 0

  for (const paper of papers) {
    try {
      if (paper.availability === 'unavailable') throw new Error('Paper was unavailable at the last synchronization')
      const document = loadDocument(root, paper.relativePath)
      const result = rankPaper(document, paper, terms)
      read++
      if (result) ranked.push(result)
    } catch (error) {
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        diagnostics.push({
          paperId: paper.paperId,
          relativePath: paper.relativePath,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  ranked.sort((left, right) => right.score - left.score
    || right.titleScore - left.titleScore
    || (left.hit.paperId < right.hit.paperId ? -1 : 1))

  const hits: PaperHit[] = []
  let remaining = MAX_SEARCH_CHARS
  let truncated = ranked.length > limit
  for (const { hit, omittedMatches } of ranked.slice(0, limit)) {
    const excerpts: PaperExcerpt[] = []
    for (const candidate of hit.excerpts) {
      if (candidate.text.length > remaining) {
        truncated = true
        break
      }
      excerpts.push(candidate)
      remaining -= candidate.text.length
      if (candidate.truncated) truncated = true
    }
    if (!excerpts.length) break
    if (omittedMatches) truncated = true
    hits.push({ ...hit, excerpts })
  }

  const requested = papers.length
  const skipped = requested - read
  return {
    hits,
    coverage: skipped === 0 ? 'complete' : read > 0 ? 'partial' : 'none',
    requested,
    read,
    skipped,
    diagnosticCount: skipped,
    diagnostics,
    truncated,
  }
}
