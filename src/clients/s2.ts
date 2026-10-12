/**
 * Semantic Scholar API client.
 *
 * Uses the public S2 Academic Graph API (https://api.semanticscholar.org/).
 * Rate-limited to 100 requests/5 minutes without an API key.
 *
 * Paper identifiers can be:
 *   - S2 paper ID (40-char hex)
 *   - DOI:10.xxx/yyy
 *   - ArXiv:2301.12345
 *   - PMID:12345678
 *   - CorpusId:12345
 */

import type { Reference, Author } from '../models/reference.js';

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';

/** Fields we request from the S2 API. */
const PAPER_FIELDS = [
  'paperId',
  'externalIds',
  'title',
  'abstract',
  'venue',
  'year',
  'authors',
  'publicationDate',
  'journal',
].join(',');

/** Raw S2 API response for a paper. */
export interface S2Paper {
  paperId: string;
  externalIds?: {
    DOI?: string;
    ArXiv?: string;
    PubMed?: string;
    PubMedCentral?: string;
    CorpusId?: number;
  };
  title?: string;
  abstract?: string;
  venue?: string;
  year?: number;
  authors?: Array<{ authorId?: string; name?: string }>;
  publicationDate?: string; // YYYY-MM-DD
  journal?: { name?: string; volume?: string; pages?: string };
}

/** Error codes matching paper-craft conventions. */
export const S2ExitCode = {
  NotFound: 1,
  Duplicate: 2,
  ApiError: 3,
} as const;

export class S2ApiError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'S2ApiError';
  }
}

/**
 * Normalize a user-provided paper identifier to S2 API format.
 *
 * Accepts: DOI, ArXiv ID, PMID, S2 CorpusId, or raw S2 paper ID.
 * Returns the identifier string suitable for the S2 /paper/{id} endpoint.
 */
export function normalizeS2Id(input: string): string {
  const trimmed = input.trim();

  // Already prefixed
  if (/^(DOI|ArXiv|PMID|CorpusId):/i.test(trimmed)) {
    return trimmed;
  }

  // DOI pattern
  if (trimmed.startsWith('10.')) {
    return `DOI:${trimmed}`;
  }

  // DOI URL
  if (trimmed.startsWith('https://doi.org/')) {
    return `DOI:${trimmed.replace('https://doi.org/', '')}`;
  }

  // ArXiv pattern (e.g., 2301.12345 or 2301.12345v2)
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(trimmed)) {
    return `ArXiv:${trimmed}`;
  }

  // Pure numeric → PMID
  if (/^\d{5,}$/.test(trimmed) && trimmed.length <= 10) {
    return `PMID:${trimmed}`;
  }

  // Otherwise assume S2 paper ID
  return trimmed;
}

/** Fetch a paper from the Semantic Scholar API. */
export async function lookupPaper(paperId: string, apiKey?: string): Promise<S2Paper> {
  const normalized = normalizeS2Id(paperId);
  const url = `${S2_BASE}/paper/${encodeURIComponent(normalized)}?fields=${PAPER_FIELDS}`;

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  const response = await fetch(url, { headers });

  if (response.status === 404) {
    throw new S2ApiError(`Paper not found: ${paperId}`, S2ExitCode.NotFound);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new S2ApiError(
      `S2 API error (${response.status}): ${body || response.statusText}`,
      S2ExitCode.ApiError,
    );
  }

  return (await response.json()) as S2Paper;
}

/**
 * Convert an S2 API paper response to our Reference model.
 *
 * Generates a citekey-style ID: `AuthorYYYY-xx` (first author last name + year).
 */
export function s2PaperToReference(paper: S2Paper): Reference {
  const firstAuthor = paper.authors?.[0]?.name?.split(' ').pop() ?? 'Unknown';
  const year = paper.year ?? 0;
  const baseId = `${firstAuthor}${year}`;

  // Parse publication date
  let month: number | undefined;
  let day: number | undefined;
  if (paper.publicationDate) {
    const parts = paper.publicationDate.split('-');
    if (parts.length >= 2) month = parseInt(parts[1], 10);
    if (parts.length >= 3) day = parseInt(parts[2], 10);
  }

  // Parse authors
  const authors: Author[] = (paper.authors ?? []).map((a) => {
    const parts = (a.name ?? '').split(' ');
    const last = parts.pop() ?? '';
    const first = parts.join(' ');
    return { first, last };
  });

  return {
    id: baseId,
    doi: paper.externalIds?.DOI ?? '',
    title: paper.title ?? '',
    authors,
    abstract: paper.abstract ?? '',
    venue: paper.journal?.name ?? paper.venue ?? '',
    volume: paper.journal?.volume,
    pages: paper.journal?.pages,
    published: { year, month, day },
    pdf_path: '',
    source: { type: 's2', id: paper.paperId },
    pmid: paper.externalIds?.PubMed,
    pmcid: paper.externalIds?.PubMedCentral,
    arxiv_id: paper.externalIds?.ArXiv,
    s2_id: paper.paperId,
  };
}

/** S2 API response for citations/references endpoints. */
interface S2PaperList {
  data: Array<{ citingPaper?: S2Paper; citedPaper?: S2Paper }>;
  next?: number;
}

/** Fetch papers that cite a given paper. */
export async function fetchCitations(
  paperId: string,
  limit = 100,
  apiKey?: string,
): Promise<S2Paper[]> {
  const normalized = normalizeS2Id(paperId);
  const url = `${S2_BASE}/paper/${encodeURIComponent(normalized)}/citations?fields=${PAPER_FIELDS}&limit=${limit}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new S2ApiError(`S2 API error (${response.status})`, S2ExitCode.ApiError);
  }

  const body = (await response.json()) as S2PaperList;
  return body.data.map((d) => d.citingPaper!).filter(Boolean);
}

/** Fetch papers referenced by a given paper. */
export async function fetchReferences(
  paperId: string,
  limit = 100,
  apiKey?: string,
): Promise<S2Paper[]> {
  const normalized = normalizeS2Id(paperId);
  const url = `${S2_BASE}/paper/${encodeURIComponent(normalized)}/references?fields=${PAPER_FIELDS}&limit=${limit}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new S2ApiError(`S2 API error (${response.status})`, S2ExitCode.ApiError);
  }

  const body = (await response.json()) as S2PaperList;
  return body.data.map((d) => d.citedPaper!).filter(Boolean);
}

