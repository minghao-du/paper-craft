/**
 * JSONL (JSON Lines) reader and writer.
 *
 * Reads/writes newline-delimited JSON files with Zod validation.
 * This is the source-of-truth persistence layer — all data lives in JSONL.
 */

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * Read all records from a JSONL file, validating each line against a Zod schema.
 *
 * Returns an empty array if the file doesn't exist. Throws on parse errors
 * with the line number for debuggability.
 */
export async function readJsonl<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const lines = content.split('\n');
  const results: T[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`JSONL parse error on line ${i + 1}: invalid JSON`);
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `JSONL validation error on line ${i + 1}: ${result.error.issues.map((e) => e.message).join(', ')}`,
      );
    }
    results.push(result.data);
  }

  return results;
}

/**
 * Append a single record to a JSONL file.
 *
 * Creates the file and parent directories if they don't exist.
 */
export async function appendJsonl<T>(path: string, record: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const line = JSON.stringify(record) + '\n';
  await appendFile(path, line, 'utf-8');
}

/**
 * Write all records to a JSONL file, replacing any existing content.
 *
 * Creates the file and parent directories if they don't exist.
 */
export async function writeJsonl<T>(path: string, records: T[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
  await writeFile(path, content, 'utf-8');
}

/** Find a record by ID in an array. Returns [index, record] or [-1, undefined]. */
export function findById<T extends { id: string }>(
  records: T[],
  id: string,
): [number, T | undefined] {
  const idx = records.findIndex((r) => r.id === id);
  return idx >= 0 ? [idx, records[idx]] : [-1, undefined];
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
