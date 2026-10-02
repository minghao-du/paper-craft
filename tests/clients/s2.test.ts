/**
 * Tests for the Semantic Scholar client — identifier normalization and
 * S2 paper → Reference conversion.
 */

import { describe, it, expect } from 'vitest';
import { normalizeS2Id, s2PaperToReference, type S2Paper } from '../../src/clients/s2.js';

describe('normalizeS2Id', () => {
  it('normalizes a plain DOI', () => {
    expect(normalizeS2Id('10.1038/s41586-021-03819-2')).toBe('DOI:10.1038/s41586-021-03819-2');
  });

  it('normalizes a DOI URL', () => {
    expect(normalizeS2Id('https://doi.org/10.1038/s41586-021-03819-2')).toBe(
      'DOI:10.1038/s41586-021-03819-2',
    );
  });

  it('normalizes an ArXiv ID', () => {
    expect(normalizeS2Id('2301.12345')).toBe('ArXiv:2301.12345');
  });

  it('normalizes an ArXiv ID with version', () => {
    expect(normalizeS2Id('2301.12345v2')).toBe('ArXiv:2301.12345v2');
  });

  it('normalizes a PMID (pure numeric, 5-10 digits)', () => {
    expect(normalizeS2Id('12345678')).toBe('PMID:12345678');
  });

  it('passes through already-prefixed identifiers', () => {
    expect(normalizeS2Id('DOI:10.1234/test')).toBe('DOI:10.1234/test');
    expect(normalizeS2Id('ArXiv:2301.12345')).toBe('ArXiv:2301.12345');
    expect(normalizeS2Id('PMID:12345')).toBe('PMID:12345');
    expect(normalizeS2Id('CorpusId:12345')).toBe('CorpusId:12345');
  });

  it('treats 40-char hex as S2 paper ID', () => {
    const s2id = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    expect(normalizeS2Id(s2id)).toBe(s2id);
  });

  it('trims whitespace', () => {
    expect(normalizeS2Id('  10.1234/test  ')).toBe('DOI:10.1234/test');
  });
});

describe('s2PaperToReference', () => {
  const samplePaper: S2Paper = {
    paperId: 'abc123',
    externalIds: {
      DOI: '10.1234/test',
      ArXiv: '2301.12345',
      PubMed: '99999999',
      PubMedCentral: 'PMC1234567',
    },
    title: 'A Test Paper on Machine Learning',
    abstract: 'This paper presents a novel approach...',
    venue: 'NeurIPS',
    year: 2023,
    authors: [
      { authorId: '1', name: 'Jane Doe' },
      { authorId: '2', name: 'John Smith' },
    ],
    publicationDate: '2023-06-15',
    journal: { name: 'Nature', volume: '42', pages: '100-110' },
  };

  it('converts S2 paper to Reference', () => {
    const ref = s2PaperToReference(samplePaper);

    expect(ref.id).toBe('Doe2023');
    expect(ref.doi).toBe('10.1234/test');
    expect(ref.title).toBe('A Test Paper on Machine Learning');
    expect(ref.authors).toEqual([
      { first: 'Jane', last: 'Doe' },
      { first: 'John', last: 'Smith' },
    ]);
    expect(ref.venue).toBe('Nature'); // journal.name takes priority
    expect(ref.volume).toBe('42');
    expect(ref.pages).toBe('100-110');
    expect(ref.published).toEqual({ year: 2023, month: 6, day: 15 });
    expect(ref.s2_id).toBe('abc123');
    expect(ref.pmid).toBe('99999999');
    expect(ref.pmcid).toBe('PMC1234567');
    expect(ref.arxiv_id).toBe('2301.12345');
    expect(ref.source).toEqual({ type: 's2', id: 'abc123' });
  });

  it('handles missing fields gracefully', () => {
    const minimal: S2Paper = {
      paperId: 'xyz',
      title: 'Minimal Paper',
      year: 2024,
    };

    const ref = s2PaperToReference(minimal);
    expect(ref.id).toBe('Unknown2024');
    expect(ref.doi).toBe('');
    expect(ref.authors).toEqual([]);
    expect(ref.venue).toBe('');
    expect(ref.published).toEqual({ year: 2024, month: undefined, day: undefined });
  });
});
