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
    tags:
      incoming.tags && incoming.tags.length > 0 ? incoming.tags : existing.tags,
    supersedes: incoming.supersedes || existing.supersedes,
    pmid: incoming.pmid || existing.pmid,
    pmcid: incoming.pmcid || existing.pmcid,
    arxiv_id: incoming.arxiv_id || existing.arxiv_id,
    s2_id: incoming.s2_id || existing.s2_id,
  };
}
