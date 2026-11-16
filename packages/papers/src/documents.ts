import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { PaperReadRange, PaperReadResult, PaperSummary } from './types.js'

interface SourceLine {
  start: number
  end: number
}

export interface SourceBlock {
  startLine: number
  endLine: number
}

export interface Document {
  title: string
  text: string
  searchableText: string
  lines: SourceLine[]
  blocks: SourceBlock[]
}

const MAX_READ_LINES = 200
const MAX_READ_CHARS = 12_000

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function checkSourceRoot(root: string): void {
  try {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) {
      throw new Error('Expected the bound source directory')
    }
    accessSync(root, constants.R_OK | constants.X_OK)
  } catch (error) {
    throw new Error(`Cannot access paper source root ${root}: ${message(error)}`)
  }
}

function openSource(root: string, relativePath: string): number {
  const path = join(root, relativePath)
  try {
    if (realpathSync(path) !== path || !lstatSync(path).isFile()) {
      throw new Error('Expected a regular paper file without symbolic links')
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Expected a regular paper file')
      return fd
    } catch (error) {
      closeSync(fd)
      throw error
    }
  } catch (error) {
    throw new Error(`Cannot open paper source ${path}: ${message(error)}`)
  }
}

export function checkReadableSource(root: string, relativePath: string): void {
  closeSync(openSource(root, relativePath))
}

export function readSource(root: string, relativePath: string): string {
  const fd = openSource(root, relativePath)
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(fd))
  } catch (error) {
    throw new Error(`Cannot read paper source ${join(root, relativePath)}: ${message(error)}`)
  } finally {
    closeSync(fd)
  }
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    lines.push({ start, end: match.index })
    start = match.index + match[0].length
  }
  if (start < text.length) lines.push({ start, end: text.length })
  return lines
}

function maskLinkMetadata(line: string): string {
  if (/^ {0,3}\[(?!\^)(?:\\.|[^\]\\])+\]:[ \t]*\S/.test(line)) return ' '.repeat(line.length)

  let visible = ''
  let start = 0
  let brackets = 0
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '\\') {
      index++
    } else if (line[index] === '[') {
      brackets++
    } else if (line[index] === ']' && brackets > 0) {
      brackets--
      if (line[index + 1] !== '(') continue
      const end = linkEnd(line, index + 2)
      if (end === -1) continue
      visible += line.slice(start, index + 1) + ' '.repeat(end - index)
      start = end + 1
      index = end
    }
  }
  return visible + line.slice(start)
}

function linkEnd(line: string, start: number): number {
  let parentheses = 1
  let closingQuote = ''
  for (let index = start; index < line.length; index++) {
    const character = line[index]
    if (character === '\\') {
      index++
    } else if (closingQuote) {
      if (character === closingQuote) closingQuote = ''
    } else if (character === '<' && !line.slice(start, index).trim()) {
      closingQuote = '>'
    } else if ((character === '"' || character === "'") && /\s/.test(line[index - 1])) {
      closingQuote = character
    } else if (character === '(') {
      parentheses++
    } else if (character === ')' && --parentheses === 0) {
      return index
    }
  }
  return -1
}

function parseMarkdown(
  text: string, lines: SourceLine[], relativePath: string,
): Pick<Document, 'title' | 'blocks' | 'searchableText'> {
  let title: string | undefined
  let fence: string | undefined
  let inComment = false
  let blockStart = 0
  const blocks: SourceBlock[] = []
  const searchableLines: string[] = []

  function finishBlock(endLine: number): void {
    if (blockStart) blocks.push({ startLine: blockStart, endLine })
    blockStart = 0
  }

  for (const [index, line] of lines.entries()) {
    const number = index + 1
    const original = text.slice(line.start, line.end)
    const fenceMatch = inComment ? null : /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(original.replace(/^\uFEFF/, ''))
    let content = original
    if (!fence && !fenceMatch) {
      let position = 0
      let visible = ''
      while (position < original.length) {
        const start = inComment ? position : original.indexOf('<!--', position)
        if (start === -1) break
        const end = original.indexOf('-->', inComment ? start : start + 4)
        const stop = end === -1 ? original.length : end + 3
        visible += original.slice(position, start) + ' '.repeat(stop - start)
        position = stop
        inComment = end === -1
      }
      content = visible + original.slice(position)
    }
    const searchable = fence || fenceMatch ? original : maskLinkMetadata(content)
    searchableLines.push(searchable)
    content = searchable.replace(/^\uFEFF/, '')
    if (fence) {
      if (fenceMatch
        && fenceMatch[1][0] === fence[0]
        && fenceMatch[1].length >= fence.length
        && !fenceMatch[2].trim()) {
        fence = undefined
        finishBlock(number)
      }
      continue
    }
    if (fenceMatch) {
      finishBlock(number - 1)
      fence = fenceMatch[1]
      blockStart = number
      continue
    }
    if (!content.trim()) {
      finishBlock(number - 1)
      continue
    }

    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(content)
    if (heading) {
      finishBlock(number - 1)
      blockStart = number
      finishBlock(number)
      if (title === undefined && heading[1] === '#') {
        title = (heading[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim()
      }
      continue
    }
    if (blockStart && /^ {0,3}=+[ \t]*$/.test(content)) {
      if (title === undefined) {
        title = searchableLines.slice(blockStart - 1, index).join(' ').trim().replace(/\s+/g, ' ')
      }
      finishBlock(number)
      continue
    }
    if (!blockStart) blockStart = number
  }

  finishBlock(lines.length)
  const searchableText = searchableLines.map((line, index) =>
    line + text.slice(lines[index].end, lines[index + 1]?.start ?? text.length),
  ).join('')
  return { title: title || basename(relativePath).slice(0, -3), blocks, searchableText }
}

export function titleOf(text: string, relativePath: string): string {
  return parseMarkdown(text, sourceLines(text), relativePath).title
}

export function loadDocument(root: string, relativePath: string): Document {
  const text = readSource(root, relativePath)
  const lines = sourceLines(text)
  return { text, lines, ...parseMarkdown(text, lines, relativePath) }
}

export function readDocument(root: string, paper: PaperSummary, range: PaperReadRange): PaperReadResult {
  const startLine = range.startLine ?? 1
  const endLine = range.endLine ?? Math.min(startLine + MAX_READ_LINES - 1, Number.MAX_SAFE_INTEGER)
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
    || startLine < 1 || endLine < startLine || endLine - startLine >= MAX_READ_LINES) {
    throw new Error(`Paper read range must contain 1–${MAX_READ_LINES} lines using positive, inclusive line numbers`)
  }

  const { title, text, lines } = loadDocument(root, paper.relativePath)
  if (startLine > Math.max(1, lines.length)) {
    throw new Error(`Line ${startLine} is past the end of paper ${paper.paperId} (${lines.length} lines)`)
  }

  let returnedEnd = startLine - 1
  const start = lines[startLine - 1]?.start ?? 0
  while (returnedEnd < Math.min(endLine, lines.length)) {
    const line = lines[returnedEnd]
    if (line.end - line.start > MAX_READ_CHARS) {
      throw new Error(`Paper ${paper.paperId} line ${returnedEnd + 1} exceeds the ${MAX_READ_CHARS}-character output limit`)
    }
    if (line.end - start > MAX_READ_CHARS) break
    returnedEnd++
  }

  return {
    paperId: paper.paperId,
    relativePath: paper.relativePath,
    title,
    text: returnedEnd >= startLine ? text.slice(start, lines[returnedEnd - 1].end) : '',
    startLine,
    endLine: returnedEnd,
    nextLine: returnedEnd < lines.length ? returnedEnd + 1 : null,
  }
}
