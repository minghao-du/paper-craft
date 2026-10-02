/**
 * Tests for the SQLite query layer (PcDatabase) — search, list, get, rebuild.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PcDatabase } from '../../src/storage/db.js';
import type { Reference } from '../../src/models/reference.js';
import type { Project } from '../../src/models/project.js';

function makeRef(id: string, title: string, year = 2024): Reference {
  return {
    id,
    doi: `10.1234/${id}`,
    title,
    authors: [{ first: 'Test', last: 'Author' }],
    abstract: `Abstract for ${title}`,
    venue: 'Test Journal',
    published: { year },
    pdf_path: `${id}.pdf`,
    source: { type: 'manual', id },
  };
}

describe('PcDatabase', () => {
  let db: PcDatabase;

  beforeEach(async () => {
    db = await PcDatabase.inMemory();
  });

  afterEach(() => {
    db.close();
  });

  describe('rebuildAll', () => {
    it('inserts references and returns counts', () => {
      const refs = [makeRef('r1', 'Machine Learning'), makeRef('r2', 'Deep Learning')];
      const projects: Project[] = [{ id: 'p1', name: 'Proj 1' }];

      const result = db.rebuildAll(refs, projects, []);
      expect(result.status).toBe('ok');
      expect(result.references).toBe(2);
      expect(result.projects).toBe(1);
      expect(result.repos).toBe(0);
    });

    it('clears old data on rebuild', () => {
      db.rebuildAll([makeRef('r1', 'Old Paper')], [], []);
      expect(db.countRefs()).toBe(1);

      db.rebuildAll([makeRef('r2', 'New Paper')], [], []);
      expect(db.countRefs()).toBe(1);
      expect(db.getRef('r1')).toBeUndefined();
      expect(db.getRef('r2')).toBeDefined();
    });
  });

  describe('getRef', () => {
    it('returns a reference by ID', () => {
      db.rebuildAll([makeRef('test-1', 'Test Paper')], [], []);
      const ref = db.getRef('test-1');
      expect(ref).toBeDefined();
      expect(ref!.title).toBe('Test Paper');
    });

    it('returns undefined for missing ID', () => {
      db.rebuildAll([], [], []);
      expect(db.getRef('nonexistent')).toBeUndefined();
    });
  });

  describe('listRefs', () => {
    it('lists all references', () => {
      const refs = [makeRef('a', 'Paper A'), makeRef('b', 'Paper B'), makeRef('c', 'Paper C')];
      db.rebuildAll(refs, [], []);

      const result = db.listRefs();
      expect(result).toHaveLength(3);
    });

    it('respects limit', () => {
      const refs = [makeRef('a', 'Paper A'), makeRef('b', 'Paper B'), makeRef('c', 'Paper C')];
      db.rebuildAll(refs, [], []);

      const result = db.listRefs(2);
      expect(result).toHaveLength(2);
    });
  });

  describe('searchRefs', () => {
    it('finds references by title keywords', () => {
      const refs = [
        makeRef('ml', 'Machine Learning Methods'),
        makeRef('dl', 'Deep Learning Networks'),
        makeRef('stats', 'Statistical Analysis'),
      ];
      db.rebuildAll(refs, [], []);

      const results = db.searchRefs('learning');
      expect(results.length).toBeGreaterThanOrEqual(2);
      const ids = results.map((r) => r.id);
      expect(ids).toContain('ml');
      expect(ids).toContain('dl');
    });

    it('finds references by abstract content', () => {
      const refs = [makeRef('r1', 'Paper One')];
      // Abstract contains "Abstract for Paper One"
      db.rebuildAll(refs, [], []);

      const results = db.searchRefs('Abstract');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('r1');
    });

    it('returns empty for no matches', () => {
      db.rebuildAll([makeRef('r1', 'Paper One')], [], []);
      const results = db.searchRefs('nonexistent_xyzzy');
      expect(results).toHaveLength(0);
    });

    it('respects limit', () => {
      const refs = Array.from({ length: 10 }, (_, i) => makeRef(`r${i}`, `Learning Paper ${i}`));
      db.rebuildAll(refs, [], []);

      const results = db.searchRefs('learning', 3);
      expect(results).toHaveLength(3);
    });
  });

  describe('countRefs', () => {
    it('counts references', () => {
      db.rebuildAll(
        [makeRef('a', 'A'), makeRef('b', 'B'), makeRef('c', 'C')],
        [],
        [],
      );
      expect(db.countRefs()).toBe(3);
    });

    it('returns 0 for empty database', () => {
      db.rebuildAll([], [], []);
      expect(db.countRefs()).toBe(0);
    });
  });
});
