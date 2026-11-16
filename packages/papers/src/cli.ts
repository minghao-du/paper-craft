#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { ProjectCollection } from './collection.js'
import { PaperLibrary } from './library.js'
import type { PaperReadRange, SearchScope } from './types.js'

const RESPONSE_LIMIT = 128 * 1024

const HELP = `Usage:
  node --import tsx packages/papers/src/cli.ts library sync|list|read|search --input /absolute/request.json
  node --import tsx packages/papers/src/cli.ts collection list|add|remove --input /absolute/request.json
  Use --input - to read the JSON request from standard input.

Every request:
  sourceRoot       Absolute Markdown source directory (required).
  libraryDir       Absolute library data directory (defaults to ~/.paper-craft/papers).
  collectionFile   Absolute shared project collection file (required for collection operations and project search).

Operation fields:
  sync             None.
  list             Optional offset (default 0) and limit (default 50, maximum 100).
  read             paperId and optional range {startLine?, endLine?} (1-based inclusive).
  search           query, scope, and optional limit (default 10, maximum 50).
                   scope is {kind:"all"}, {kind:"papers",paperIds:[...]}, or {kind:"project"}.
  add, remove      paperIds (array of nonblank paper IDs).

Standard output is {ok:true,result} on success or {ok:false,error:{code,message}} on failure.
`

class CliError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function invalid(message: string): never {
  throw new CliError('invalid_input', message)
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${name} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function checkFields(data: Record<string, unknown>, names: string[]): void {
  const unknown = Object.keys(data).find((key) => !names.includes(key))
  if (unknown !== undefined) invalid(`Unexpected field: ${unknown}`)
}

function nonblank(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${name} must be a nonblank string`)
  }
  return value
}

function absolutePath(value: unknown, name: string): string {
  const path = nonblank(value, name)
  if (!isAbsolute(path) || path.includes('\0')) invalid(`${name} must be an absolute path`)
  return path
}

function optionalInteger(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function paperIds(value: unknown): string[] {
  if (!Array.isArray(value)) invalid('paperIds must be an array')
  return value.map((id) => nonblank(id, 'paperIds entry'))
}

function readRange(value: unknown): PaperReadRange | undefined {
  if (value === undefined) return undefined
  const data = object(value, 'range')
  checkFields(data, ['startLine', 'endLine'])
  return {
    startLine: optionalInteger(data.startLine, 'startLine', 1),
    endLine: optionalInteger(data.endLine, 'endLine', 1),
  }
}

function searchScope(value: unknown, getCollection: () => ProjectCollection): SearchScope {
  const data = object(value, 'scope')
  switch (data.kind) {
    case 'all':
      checkFields(data, ['kind'])
      return { kind: 'all' }
    case 'papers':
      checkFields(data, ['kind', 'paperIds'])
      return { kind: 'papers', paperIds: paperIds(data.paperIds) }
    case 'project':
      checkFields(data, ['kind'])
      return { kind: 'papers', paperIds: getCollection().list().paperIds }
    default:
      return invalid('scope.kind must be all, papers, or project')
  }
}

function clipped(value: string, limit: number): string {
  if (value.length <= limit) return value
  return value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…'
}

function displayTitle<T extends { title: string }>(item: T): T {
  return { ...item, title: clipped(item.title, 300) }
}

function request(input: string): Record<string, unknown> {
  const path = input === '-' ? 0 : absolutePath(input, '--input')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new CliError('input_io', `Could not read the request from ${input === '-' ? 'standard input' : input}`)
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return invalid('Request contains invalid JSON')
  }
  return object(data, 'Request')
}

const OPERATION_FIELDS: Record<string, string[]> = {
  'library sync': [],
  'library list': ['offset', 'limit'],
  'library read': ['paperId', 'range'],
  'library search': ['query', 'scope', 'limit'],
  'collection list': ['offset', 'limit'],
  'collection add': ['paperIds'],
  'collection remove': ['paperIds'],
}

function run(args: string[]): unknown {
  const [area, operation, flag, input] = args
  const command = `${area} ${operation}`
  if (args.length !== 4 || flag !== '--input' || !Object.hasOwn(OPERATION_FIELDS, command)) {
    invalid('Expected <library|collection> <operation> --input /absolute/request.json (or --input -). See --help.')
  }

  const data = request(input)
  checkFields(data, ['sourceRoot', 'libraryDir', 'collectionFile', ...OPERATION_FIELDS[command]])
  const sourceRoot = absolutePath(data.sourceRoot, 'sourceRoot')
  const libraryDir = data.libraryDir === undefined
    ? join(homedir(), '.paper-craft', 'papers')
    : absolutePath(data.libraryDir, 'libraryDir')
  const collectionFile = data.collectionFile === undefined
    ? undefined
    : absolutePath(data.collectionFile, 'collectionFile')
  const library = new PaperLibrary({ sourceRoot, libraryDir })
  const getCollection = () => new ProjectCollection({
    collectionFile: collectionFile ?? invalid('collectionFile is required'),
    library,
  })

  switch (command) {
    case 'library sync': {
      const result = library.sync()
      const display = { ...result, changes: result.changes.map(displayTitle) }
      return responseSize(display) <= RESPONSE_LIMIT ? display : { ...result, changes: [], truncated: true }
    }
    case 'library list': {
      const result = library.list({
        offset: optionalInteger(data.offset, 'offset', 0),
        limit: optionalInteger(data.limit, 'limit', 1, 100),
      })
      return { ...result, papers: result.papers.map(displayTitle) }
    }
    case 'library read':
      return displayTitle(library.read(nonblank(data.paperId, 'paperId'), readRange(data.range)))
    case 'library search': {
      const query = nonblank(data.query, 'query')
      const limit = optionalInteger(data.limit, 'limit', 1, 50)
      const result = library.search(query, searchScope(data.scope, getCollection), limit)
      return {
        ...result,
        hits: result.hits.map(displayTitle),
        diagnostics: result.diagnostics.map((item) => ({ ...item, message: clipped(item.message, 500) })),
      }
    }
    case 'collection list': {
      const offset = optionalInteger(data.offset, 'offset', 0) ?? 0
      const limit = optionalInteger(data.limit, 'limit', 1, 100) ?? 50
      const { libraryId, paperIds } = getCollection().list()
      const end = offset + limit
      return {
        libraryId,
        paperIds: paperIds.slice(offset, end),
        total: paperIds.length,
        nextOffset: end < paperIds.length ? end : null,
      }
    }
    case 'collection add':
    case 'collection remove': {
      const ids = [...new Set(paperIds(data.paperIds))]
      // Both result lists partition the input IDs. Reserve space for the envelope and counts.
      const includeIds = ids.length <= 100 && responseSize(ids) <= RESPONSE_LIMIT - 1024
      const collection = getCollection()
      if (command === 'collection add') {
        const result = collection.add(ids)
        return includeIds ? result : { ...result, addedIds: [], alreadyPresentIds: [], truncated: true }
      }
      const result = collection.remove(ids)
      return includeIds ? result : { ...result, removedIds: [], alreadyAbsentIds: [], truncated: true }
    }
    default:
      return invalid('Unrecognized papers operation')
  }
}

function responseSize(result: unknown): number {
  return Buffer.byteLength(JSON.stringify({ ok: true, result })) + 1
}

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(HELP)
} else {
  try {
    const result = run(args)
    const output = JSON.stringify({ ok: true, result }) + '\n'
    if (Buffer.byteLength(output) > RESPONSE_LIMIT) {
      throw new CliError('output_limit', 'Response exceeds 128 KiB. Request fewer entries or a smaller range.')
    }
    process.stdout.write(output)
  } catch (error) {
    const code = error instanceof CliError ? error.code : 'operation_failed'
    const message = clipped(error instanceof Error ? error.message : String(error), 500)
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + '\n')
    process.exitCode = 1
  }
}
