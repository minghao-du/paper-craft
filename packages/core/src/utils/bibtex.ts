/**
 * BibTeX export for references.
 *
 * Generates BibTeX entries from Reference objects. Handles author formatting,
 * special character escaping, and field mapping.
 */

import type { Reference } from '../models/reference.js';

/** Escape special LaTeX characters in a string. */
function escapeLatex(s: string): string {
  return s
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_');
}

/** Format authors for BibTeX: "Last, First and Last, First". */
function formatAuthors(ref: Reference): string {
  return ref.authors.map((a) => `${a.last}, ${a.first}`).join(' and ');
}

/** Convert a Reference to a BibTeX entry string. */
export function toBibtex(ref: Reference): string {
  const fields: string[] = [];

  const add = (key: string, value: string | number | undefined) => {
    if (value === undefined || value === '' || value === 0) return;
    const v = typeof value === 'number' ? String(value) : `{${escapeLatex(value)}}`;
    fields.push(`  ${key} = ${v}`);
  };

  add('title', ref.title);
  if (ref.authors.length > 0) {
    fields.push(`  author = {${formatAuthors(ref)}}`);
  }
  add('year', ref.published.year);
  add('journal', ref.venue);
  add('volume', ref.volume);
  add('number', ref.issue);
  add('pages', ref.pages);
  add('doi', ref.doi);
  add('abstract', ref.abstract);
  add('note', ref.note);
  if (ref.pmid) add('pmid', ref.pmid);
  if (ref.pmcid) add('pmcid', ref.pmcid);

  const entryType = ref.venue?.toLowerCase().includes('arxiv') ? 'article' : 'article';
  return `@${entryType}{${ref.id},\n${fields.join(',\n')}\n}`;
}

/** Convert multiple references to a BibTeX file string. */
export function toBibtexFile(refs: Reference[]): string {
  return refs.map(toBibtex).join('\n\n') + '\n';
}
