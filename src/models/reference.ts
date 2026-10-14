/**
 * Core domain types for academic references.
 *
 * These Zod schemas serve as both runtime validators (for JSONL ingestion)
 * and TypeScript type definitions. The shapes intentionally match the JSONL
 * on-disk format — field names use snake_case to stay JSON-native.
 */

import { z } from 'zod';

/** An academic paper author with optional ORCID identifier. */
export const AuthorSchema = z.object({
  first: z.string(),
  last: z.string(),
  orcid: z.string().optional(),
});
export type Author = z.infer<typeof AuthorSchema>;

/** Publication date with optional month and day. */
export const PublicationDateSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(0).max(12).optional(), // 1-12, 0 or absent if unknown
  day: z.number().int().min(0).max(31).optional(), // 1-31, 0 or absent if unknown
});
export type PublicationDate = z.infer<typeof PublicationDateSchema>;

/** Tracks where a reference was imported from. */
export const ImportSourceSchema = z.object({
  type: z.string(), // paperpile, zotero, mendeley, manual, s2
  id: z.string(), // Original ID from source system
});
export type ImportSource = z.infer<typeof ImportSourceSchema>;

/** An academic paper or article — the core domain entity. */
export const ReferenceSchema = z.object({
  // Identity
  id: z.string(),
  doi: z.string(),

  // Metadata
  title: z.string(),
  authors: z.array(AuthorSchema),
  abstract: z.string(),
  venue: z.string(),
  volume: z.string().optional(),
  issue: z.string().optional(),
  pages: z.string().optional(),
  note: z.string().optional(),

  // Publication date
  published: PublicationDateSchema,

  // File paths (relative to configured PDF root)
  pdf_path: z.string(),
  supplement_paths: z.array(z.string()).optional(),

  // Import tracking
  source: ImportSourceSchema,

  // Tags for organizing references
  tags: z.array(z.string()).optional(),

  // Relationships
  supersedes: z.string().optional(), // DOI of paper this replaces

  // External identifiers
  pmid: z.string().optional(),
  pmcid: z.string().optional(),
  arxiv_id: z.string().optional(),
  s2_id: z.string().optional(),
});
export type Reference = z.infer<typeof ReferenceSchema>;

/**
 * Merge an incoming reference with an existing one.
 *
 * For every field, an incoming falsy/empty value falls back to the existing
 * value. This preserves post-import enrichments (e.g., PMCIDs added by
 * backfill) when the import source doesn't carry that field.
 *
 * `id` and `source` are always taken from `incoming` because they describe
 * the import event itself.
 */
export function mergeReferences(existing: Reference, incoming: Reference): Reference {
  const allTags = [...(existing.tags ?? []), ...(incoming.tags ?? [])];
  const mergedTags = allTags.length > 0 ? Array.from(new Set(allTags)) : undefined;

  return {
    // Identity — always from incoming
    id: incoming.id,
    source: incoming.source,

    // Everything else — incoming wins if non-empty, else keep existing
    doi: incoming.doi || existing.doi,
    title: incoming.title || existing.title,
    authors: incoming.authors.length > 0 ? incoming.authors : existing.authors,
    abstract: incoming.abstract || existing.abstract,
    venue: incoming.venue || existing.venue,
    volume: incoming.volume || existing.volume,
    issue: incoming.issue || existing.issue,
    pages: incoming.pages || existing.pages,
    note: incoming.note || existing.note,
    published: incoming.published.year ? incoming.published : existing.published,
    pdf_path: incoming.pdf_path || existing.pdf_path,
    supplement_paths:
      incoming.supplement_paths && incoming.supplement_paths.length > 0
        ? incoming.supplement_paths
        : existing.supplement_paths,
    tags: mergedTags,
    supersedes: incoming.supersedes || existing.supersedes,
    pmid: incoming.pmid || existing.pmid,
    pmcid: incoming.pmcid || existing.pmcid,
    arxiv_id: incoming.arxiv_id || existing.arxiv_id,
    s2_id: incoming.s2_id || existing.s2_id,
  };
}

/**
 * Check if two references are identical in all fields.
 *
 * Treats undefined and empty/missing optional string fields as equivalent.
 * Compares tags as sets (order-independent).
 */
export function referencesEqual(a: Reference, b: Reference): boolean {
  if (
    a.id !== b.id ||
    a.doi !== b.doi ||
    a.title !== b.title ||
    a.abstract !== b.abstract ||
    a.venue !== b.venue ||
    (a.volume ?? '') !== (b.volume ?? '') ||
    (a.issue ?? '') !== (b.issue ?? '') ||
    (a.pages ?? '') !== (b.pages ?? '') ||
    (a.note ?? '') !== (b.note ?? '') ||
    a.pdf_path !== b.pdf_path ||
    (a.supersedes ?? '') !== (b.supersedes ?? '') ||
    (a.pmid ?? '') !== (b.pmid ?? '') ||
    (a.pmcid ?? '') !== (b.pmcid ?? '') ||
    (a.arxiv_id ?? '') !== (b.arxiv_id ?? '') ||
    (a.s2_id ?? '') !== (b.s2_id ?? '')
  ) {
    return false;
  }

  if (a.source.type !== b.source.type || a.source.id !== b.source.id) {
    return false;
  }

  if (
    a.published.year !== b.published.year ||
    (a.published.month ?? 0) !== (b.published.month ?? 0) ||
    (a.published.day ?? 0) !== (b.published.day ?? 0)
  ) {
    return false;
  }

  if (a.authors.length !== b.authors.length) return false;
  for (let i = 0; i < a.authors.length; i++) {
    const aAuth = a.authors[i];
    const bAuth = b.authors[i];
    if (
      aAuth.first !== bAuth.first ||
      aAuth.last !== bAuth.last ||
      (aAuth.orcid ?? '') !== (bAuth.orcid ?? '')
    ) {
      return false;
    }
  }

  const aTags = a.tags ?? [];
  const bTags = b.tags ?? [];
  if (aTags.length !== bTags.length) return false;
  const sortedA = [...aTags].sort();
  const sortedB = [...bTags].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }

  const aSupp = a.supplement_paths ?? [];
  const bSupp = b.supplement_paths ?? [];
  if (aSupp.length !== bSupp.length) return false;
  for (let i = 0; i < aSupp.length; i++) {
    if (aSupp[i] !== bSupp[i]) return false;
  }

  return true;
}

