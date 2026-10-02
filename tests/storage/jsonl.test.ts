/**
 * Tests for the JSONL storage layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { readJsonl, appendJsonl, writeJsonl, findById } from '../../src/storage/jsonl.js';

const TestSchema = z.object({
  id: z.string(),
  name: z.string(),
  value: z.number().optional(),
});
type TestRecord = z.infer<typeof TestSchema>;

describe('JSONL storage', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pc-test-'));
    filePath = join(dir, 'test.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('readJsonl', () => {
    it('returns empty array for missing file', async () => {
      const result = await readJsonl(filePath, TestSchema);
      expect(result).toEqual([]);
    });

    it('reads and validates records', async () => {
      const records: TestRecord[] = [
        { id: 'a', name: 'Alice', value: 1 },
        { id: 'b', name: 'Bob' },
      ];
      await writeJsonl(filePath, records);

      const result = await readJsonl(filePath, TestSchema);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: 'a', name: 'Alice', value: 1 });
      expect(result[1]).toEqual({ id: 'b', name: 'Bob' });
    });

    it('throws on invalid JSON', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(filePath, 'not json\n', 'utf-8');

      await expect(readJsonl(filePath, TestSchema)).rejects.toThrow('invalid JSON');
    });

    it('throws on schema validation failure', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(filePath, '{"id": 123}\n', 'utf-8');

      await expect(readJsonl(filePath, TestSchema)).rejects.toThrow('validation error');
    });

    it('skips blank lines', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        filePath,
        '{"id":"a","name":"Alice"}\n\n{"id":"b","name":"Bob"}\n',
        'utf-8',
      );

      const result = await readJsonl(filePath, TestSchema);
      expect(result).toHaveLength(2);
    });
  });

  describe('appendJsonl', () => {
    it('creates file and appends', async () => {
      await appendJsonl(filePath, { id: 'a', name: 'Alice' });
      await appendJsonl(filePath, { id: 'b', name: 'Bob' });

      const result = await readJsonl(filePath, TestSchema);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('a');
      expect(result[1].id).toBe('b');
    });

    it('creates parent directories', async () => {
      const nested = join(dir, 'sub', 'deep', 'test.jsonl');
      await appendJsonl(nested, { id: 'x', name: 'test' });

      const result = await readJsonl(nested, TestSchema);
      expect(result).toHaveLength(1);
    });
  });

  describe('writeJsonl', () => {
    it('overwrites existing content', async () => {
      await writeJsonl(filePath, [
        { id: 'a', name: 'Alice' },
        { id: 'b', name: 'Bob' },
      ]);
      await writeJsonl(filePath, [{ id: 'c', name: 'Charlie' }]);

      const result = await readJsonl(filePath, TestSchema);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('c');
    });

    it('round-trips correctly', async () => {
      const records: TestRecord[] = [
        { id: 'a', name: 'Alice', value: 42 },
        { id: 'b', name: 'Bob', value: 0 },
        { id: 'c', name: 'Charlie' },
      ];
      await writeJsonl(filePath, records);

      const result = await readJsonl(filePath, TestSchema);
      expect(result).toEqual(records);
    });
  });

  describe('findById', () => {
    it('finds existing record', () => {
      const records = [
        { id: 'a', name: 'Alice' },
        { id: 'b', name: 'Bob' },
      ];
      const [idx, record] = findById(records, 'b');
      expect(idx).toBe(1);
      expect(record?.name).toBe('Bob');
    });

    it('returns -1 for missing record', () => {
      const records = [{ id: 'a', name: 'Alice' }];
      const [idx, record] = findById(records, 'z');
      expect(idx).toBe(-1);
      expect(record).toBeUndefined();
    });
  });
});
