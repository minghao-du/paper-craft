/**
 * Tests for the Reference model — Zod schema validation and merge logic.
 */

import { describe, it, expect } from 'vitest';
import { ReferenceSchema, mergeReferences } from '../../src/models/reference.js';
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
});
