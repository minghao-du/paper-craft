/**
 * Tests for the Reference model — Zod schema validation and merge logic.
 */

import { describe, it, expect } from 'vitest';
import { ReferenceSchema, mergeReferences, referencesEqual } from '../../src/models/reference.js';
import type { Reference } from '../../src/models/reference.js';

/** A minimal valid Reference for testing. */
function makeRef(overrides: Partial<Reference> = {}): Reference {
  return {
    id: 'Test2024-ab',
    doi: '10.1234/test',
    title: 'A Test Paper',
    authors: [{ first: 'Jane', last: 'Doe' }],
    abstract: 'This is a test.',
    venue: 'Test Journal',
    published: { year: 2024 },
    pdf_path: 'Test2024-ab.pdf',
    source: { type: 'manual', id: 'test-1' },
    ...overrides,
  };
}

describe('ReferenceSchema', () => {
  it('validates a complete reference', () => {
    const ref = makeRef();
    const result = ReferenceSchema.safeParse(ref);
    expect(result.success).toBe(true);
  });

  it('accepts optional fields when absent', () => {
    const ref = makeRef();
    // No volume, issue, pages, note, tags, etc.
    const result = ReferenceSchema.safeParse(ref);
    expect(result.success).toBe(true);
  });

  it('accepts optional fields when present', () => {
    const ref = makeRef({
      volume: '42',
      issue: '3',
      pages: '100-110',
      note: 'Important paper',
      tags: ['review', 'methods'],
      supplement_paths: ['supp1.pdf'],
      supersedes: '10.1234/old',
      pmid: '12345678',
      pmcid: 'PMC1234567',
      arxiv_id: '2024.01234',
      s2_id: 'abc123',
    });
    const result = ReferenceSchema.safeParse(ref);
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = ReferenceSchema.safeParse({ id: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('mergeReferences', () => {
  it('takes id and source from incoming', () => {
    const existing = makeRef({ id: 'Old-id', source: { type: 'paperpile', id: 'pp-1' } });
    const incoming = makeRef({ id: 'New-id', source: { type: 's2', id: 's2-1' } });

    const merged = mergeReferences(existing, incoming);
    expect(merged.id).toBe('New-id');
    expect(merged.source.type).toBe('s2');
  });

  it('keeps existing value when incoming is empty', () => {
    const existing = makeRef({ pmcid: 'PMC999', s2_id: 'abc' });
    const incoming = makeRef({ pmcid: undefined, s2_id: undefined });

    const merged = mergeReferences(existing, incoming);
    expect(merged.pmcid).toBe('PMC999');
    expect(merged.s2_id).toBe('abc');
  });

  it('uses incoming value when non-empty', () => {
    const existing = makeRef({ venue: 'Old Journal' });
    const incoming = makeRef({ venue: 'New Journal' });

    const merged = mergeReferences(existing, incoming);
    expect(merged.venue).toBe('New Journal');
  });

  it('keeps existing authors when incoming has none', () => {
    const existing = makeRef({ authors: [{ first: 'Jane', last: 'Doe' }] });
    const incoming = makeRef({ authors: [] });

    const merged = mergeReferences(existing, incoming);
    expect(merged.authors).toEqual([{ first: 'Jane', last: 'Doe' }]);
  });

  it('keeps existing published date when incoming year is 0', () => {
    const existing = makeRef({ published: { year: 2023, month: 6 } });
    const incoming = makeRef({ published: { year: 0 } });

    const merged = mergeReferences(existing, incoming);
    expect(merged.published.year).toBe(2023);
    expect(merged.published.month).toBe(6);
  });

  it('unions existing and incoming tags preserving uniqueness', () => {
    const existing = makeRef({ tags: ['local-tag', 'shared-tag'] });
    const incoming = makeRef({ tags: ['shared-tag', 'zotero-tag'] });

    const merged = mergeReferences(existing, incoming);
    expect(merged.tags).toEqual(['local-tag', 'shared-tag', 'zotero-tag']);
  });

  it('keeps existing tags when incoming has no tags', () => {
    const existing = makeRef({ tags: ['local-tag'] });
    const incoming = makeRef({ tags: undefined });

    const merged = mergeReferences(existing, incoming);
    expect(merged.tags).toEqual(['local-tag']);
  });

  it('uses incoming tags when existing has no tags', () => {
    const existing = makeRef({ tags: undefined });
    const incoming = makeRef({ tags: ['zotero-tag'] });

    const merged = mergeReferences(existing, incoming);
    expect(merged.tags).toEqual(['zotero-tag']);
  });
});

describe('referencesEqual', () => {
  it('returns true for identical references', () => {
    const a = makeRef();
    const b = makeRef();
    expect(referencesEqual(a, b)).toBe(true);
  });

  it('returns true when optional undefined fields match absent fields', () => {
    const a = makeRef({ note: undefined, tags: undefined, pmid: undefined });
    const b = makeRef();
    delete (b as any).note;
    delete (b as any).tags;
    delete (b as any).pmid;
    expect(referencesEqual(a, b)).toBe(true);
  });

  it('returns false when fields differ', () => {
    const a = makeRef({ title: 'Title A' });
    const b = makeRef({ title: 'Title B' });
    expect(referencesEqual(a, b)).toBe(false);
  });

  it('returns true when tags have same elements regardless of order', () => {
    const a = makeRef({ tags: ['tagA', 'tagB'] });
    const b = makeRef({ tags: ['tagB', 'tagA'] });
    expect(referencesEqual(a, b)).toBe(true);
  });

  it('returns false when tags differ', () => {
    const a = makeRef({ tags: ['tagA'] });
    const b = makeRef({ tags: ['tagA', 'tagB'] });
    expect(referencesEqual(a, b)).toBe(false);
  });

  it('returns false when authors differ', () => {
    const a = makeRef({ authors: [{ first: 'Jane', last: 'Doe' }] });
    const b = makeRef({ authors: [{ first: 'John', last: 'Doe' }] });
    expect(referencesEqual(a, b)).toBe(false);
  });

  it('returns false when published date differs', () => {
    const a = makeRef({ published: { year: 2024, month: 1 } });
    const b = makeRef({ published: { year: 2024, month: 2 } });
    expect(referencesEqual(a, b)).toBe(false);
  });
});


