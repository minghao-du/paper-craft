---
name: pc-lit
description: Unified guidance for using the paper-craft reference library CLI. Use when searching for papers, managing the library, or exploring literature via S2/ASTA.
---

# Bip Reference Library

A CLI tool for managing academic references with local storage and external paper search.

**Repository**: Configured via `nexus_path` in `~/.config/pc/config.yml`

**Issues**: https://github.com/matsen/bipartite/issues

## ⚠️ CRITICAL: Local-First, Paper-First Policy

**ALWAYS search locally before using external APIs.
NEVER call ASTA without explicit user permission.**

**When answering questions about papers, READ THE ACTUAL PAPER PDF.**
Do not rely on abstracts, S2 metadata, or ASTA when the paper is in the local library.
Reach for the right reader for the job:

- **Text and search → pdf-navigator MCP (MuPDF).**
  Use `search_pdf_text` to jump to the relevant pages, then `read_pdf_text` / `read_pdf_page`.
  MuPDF keeps reading order across columns and inline math intact, and the text is searchable.
  This is the default.
- **Figures, panels, rendered equations, tables → built-in `Read` with a narrow `pages` range.**
  The built-in reader renders pages as *images* (token-heavy, not searchable), so use it only for the 1–3 pages that hold the visual you need — never the whole paper.

The nexus library has ~6000 papers.
Most relevant papers are already there.

### Required Search Order

1. **Local search FIRST** (always do this):
   ```bash
   pc search -a "LastName" "keyword" --human
   ```
**Always use `--human`** — the default JSON output is verbose and easy to mis-scan.

2. **If `pc search` fails** (e.g., schema error), rebuild the database:
   ```bash
   pc rebuild
   ```
Then retry the search.

3. **If found locally, READ THE PAPER** to answer the question:
   ```bash
   pc get <id> --human   # Get PDF path
   ```
Then use `mcp__pdf-navigator__search_pdf_text` (jump to the page) and `mcp__pdf-navigator__read_pdf_text` to find the answer directly in the paper.
For a figure or equation you need to *see*, use the built-in `Read` tool on a narrow `pages` range instead.
Get the PDF base path from `pc config pdf-root --human` rather than hardcoding it — it differs per machine (a Google Drive path on macOS, an rclone mount such as `~/gdrive/Paperpile` on Linux) and `$BIP_PDF_ROOT` may override the configured value.

4. **Before concluding a paper is absent, try an exact-match check** — `pc search -a "LastName"` or `pc search --doi "..."` — rather than another keyword permutation.
   `pc search` reports when results are truncated (`Found N references (showing M; ...)`), so a plain "not found" is trustworthy, but a truncated keyword search on its own is not proof of absence.

5. **Only if not found locally AND user confirms**, use ASTA:
   ```
   "I couldn't find that paper in the local library. Would you like me to search Semantic Scholar (ASTA)?"
   ```

**DO NOT** call `pc asta`, `mcp__asta__*`, or any external API without asking first.

**DO NOT** rely on abstracts or S2 metadata when you have access to the actual paper PDF.

## Argument Handling

When invoked with arguments like `/pc-lit find <query>` or `/pc-lit <query>`:

1. **Always search local library first** with `pc search "<query>" --human`
2. If local search fails with an error, rebuild the database and retry
3. **If found locally and answering a question, read the paper PDF** using pdf-navigator tools
4. **Only after exhausting local options**, ask user if they want to search externally
5. For title searches, use the full title; for topic searches, use key terms

## Quick Reference

| Task | Command |
|------|---------|
| Search local library | `pc search "query" --human` (searches title, abstract, authors, notes) |
| Search by author | `pc search -a "LastName" --human` |
| Search by title | `pc search -t "keywords" --human` |
| Search by year | `pc search --year 2024 --human` |
| Search by note | `pc search "AlphaSeq" --human` (user notes from Paperpile are indexed) |
| Search by venue | `pc search --venue "Nature" --human` |
| Lookup by DOI | `pc search --doi "10.1234/..." --human` |
| Combined search | `pc search "topic" -a "Author" --year 2020: --human` |
| Limit results | `pc search "topic" --limit 100 --human` (default 50, ranked by relevance) |
| Unlimited results | `pc search "topic" --limit 0 --human` (`-1` also works) |
| Get paper details | `pc get <id>` |
| Export to BibTeX | `pc export --bibtex <id>...` |
| Append to .bib file | `pc export --bibtex --append main.bib <id>...` |
| Add paper to collection | `pc s2 add DOI:10.1234/...` |
| Find literature gaps | `pc s2 gaps` |
| Backfill missing PMCIDs from NCBI | `pc ncbi backfill --dry-run` |
| One-off PMCID lookup | `pc ncbi pmcid DOI:10.1234/...` |
| Fast paper search (external) | `pc asta search "query"` |
| Import from Zotero | `pc import --format zotero [--zotero-path <path>] [--library <id>] [--dry-run]` |
| Import from Paperpile | `pc import --format paperpile <file> [--dry-run]` |
| Rebuild search index | `pc rebuild --human` (run after import) |
| Import projects from config | `pc project import <file>` |

## Search Strategy

### Field-Specific Search Flags

Use `--author` and `--year` flags for precise filtering:

```bash
# Search by author (exact last name matching to avoid false positives)
pc search --author "Yu" --author "Bloom"    # Last names only
pc search -a "Tim Yu" -a "Bloom"            # First + last name
pc search -a "Yu, Timothy"                  # Last, First format

# Filter by year
pc search --year 2024           # exact year
pc search --year 2020:2024      # range (inclusive)
pc search --year 2022:          # 2022 and later
pc search --year :2020          # 2020 and earlier

# Combine keyword + filters
pc search "deep mutational scanning" --author "Bloom" --year 2023:
```

**Multiple authors use AND logic** - all must appear in the paper.

**Author matching rules:**
- Single word (e.g., `-a "Yu"`) → exact last name match (won't match "Yujia")
- Two+ words (e.g., `-a "Tim Yu"`) → exact last name + first name prefix
- Comma format (e.g., `-a "Yu, Tim"`) → same as above

### Query Formulation Tips

**Keep queries short and specific** - long conceptual queries are a correctness hazard, not just slow: `pc search` uses exact-token AND matching, so one inflected or half-remembered word (e.g. plural vs. singular) can zero out an otherwise-matching query:
- Bad: `"correlation between BME criterion and Felsenstein likelihood around correct tree"`
- Good: `"BME Felsenstein likelihood phylogeny"` or `"Bruno WEIGHBOR likelihood"`

**Use --author flag instead of embedding names in query** - Precise last name matching:
- Good: `pc search -a "Yu" -a "Bloom" --year 2022:` (exact last name match)
- Good: `pc search -a "Tim Yu" -a "Bloom"` (first prefix + exact last name)
- Bad: `pc search "Tim Yu Bloom"` (keyword search is substring-based)

**Use specific method/algorithm names**:
- `"WEIGHBOR"`, `"FASTME"`, `"neighbor joining"` rather than general descriptions

### Systematic Search Workflow

For finding a specific paper or result:

1. **Local library first** (fastest, already curated):
   ```bash
   # Use flags for author/year filtering (most reliable)
   pc search -a "AuthorName" --year 2020: --human
   pc search "topic" -a "Author" --human

   # Or plain keyword search (use -a for authors when possible)
   pc search "distinctive title words" --human
   ```

2. **If found, read the paper** to get authoritative answers:
   ```bash
   pc get <id> --human  # Get PDF path
   # Then use pdf-navigator to search/read the PDF
   ```

3. **External keyword search** (only if not found locally, with permission):
   ```bash
   pc asta search "AuthorName keyword1 keyword2" --limit 20 --human
   ```

4. **Broaden if needed** - remove author, try synonyms:
   ```bash
   pc asta search "minimum evolution likelihood" --human
   pc asta search "distance method maximum likelihood phylogeny" --human
   ```

5. **Citation tracing** - if you find a related paper, check what cites it:
   ```bash
   pc asta citations DOI:10.xxxx/yyyy --limit 50 --human
   ```

6. **MCP tools directly** - for more control over fields and filters:
   ```
   mcp__asta__search_papers_by_relevance with specific date ranges
   mcp__asta__get_citations with publication_date_range filter
   ```

### Snippet Search Caveats

The `pc asta snippet` command can be **slow and unreliable** (timeouts are common).
Alternatives:
- Use keyword search first to find candidate papers
- Use MCP `mcp__asta__snippet_search` directly with smaller limits
- If snippet times out, fall back to `pc asta search`

## S2 vs ASTA vs NCBI: When to Use Which

S2 and ASTA both access Semantic Scholar; NCBI is a separate ID-resolution service:

| Use Case | Command | Why |
|----------|---------|-----|
| Add paper to collection | `pc s2 add` | Only S2 can modify local library |
| Find literature gaps | `pc s2 gaps` | Analyzes your collection |
| Explore without adding | `pc asta *` | Faster, read-only |
| Find text snippets in papers | `pc asta snippet` | Unique to ASTA |
| Fast paper search | `pc asta search` | 10x faster rate limit |
| Get citations/references | Either S2 or ASTA | ASTA is faster |
| Backfill PMCIDs (e.g., for NIH RPPR) | `pc ncbi backfill` | NCBI is the canonical source; S2/ASTA do not return PMCIDs reliably |

**Rule of thumb**: Use `pc asta` for exploration, `pc s2` when you want to modify your library, `pc ncbi` for authoritative PMCID resolution.
NCBI only knows PMCIDs for papers actually in PMC — absence is not a signal that the paper is missing.

See [api-guide.md](api-guide.md) for detailed comparison.

## Common Workflows

### Find a Paper / Answer a Question About a Paper

1. **Search local library first**:
   ```bash
   pc search "Schmidler phylogenetics" --human
   ```

2. **Get PDF path** for a result:
   ```bash
   pc get <id> --human
   # full path = `pc config pdf-root --human` + the pdf_path field
   ```

3. **Read the actual paper** to answer questions:
   ```bash
   # Text: search to the relevant page (MuPDF — searchable, clean reading order)
   mcp__pdf-navigator__search_pdf_text(file_path, "phage display")
   mcp__pdf-navigator__read_pdf_text(file_path, 2, 3)
   ```
For a **figure, panel, or rendered equation** you need to *see*, use the built-in `Read` tool on a narrow page range instead (it renders pages as images — token-heavy, so read only the page(s) with the visual):
   ```
   Read(file_path, pages="4")
   ```
**Always prefer reading the paper over relying on abstracts or external metadata.**

4. **Only if not in library**, search externally (with user permission):
   ```bash
   pc asta search "phylogenetic inference"
   ```

### Update Library from Paperpile

1. Export from Paperpile (JSON format) to ~/Downloads
2. Find the export file:
   ```bash
   ls -t ~/Downloads/Paperpile*.json | head -1
   ```
3. Import:
   ```bash
   pc import --format paperpile "<path>"
   ```
4. Rebuild the search index:
   ```bash
   pc rebuild
   ```
5. Optionally delete the export file after confirming success

### Explore Literature

1. **Search by topic**:
   ```bash
   pc asta search "variational inference phylogenetics" --limit 20
   ```

2. **Find specific text passages**:
   ```bash
   pc asta snippet "Bayesian phylogenetic inference"
   ```

3. **Trace citations**:
   ```bash
   pc asta citations DOI:10.1093/sysbio/syy032
   pc asta references DOI:10.1093/sysbio/syy032
   ```

4. **Add interesting papers** to your collection:
   ```bash
   pc s2 add DOI:10.1093/sysbio/syy032
   ```

See [workflows.md](workflows.md) for detailed workflow instructions.

## Output Format

All commands output JSON by default.
Add `--human` for readable format:

```bash
pc asta search "phylogenetics" --human
pc s2 lookup DOI:10.1234/example --human
```

## Paper ID Formats

Both S2 and ASTA accept these identifier formats:
- `DOI:10.1093/sysbio/syy032`
- `ARXIV:2106.15928`
- `PMID:19872477`
- `CorpusId:215416146`
- Raw Semantic Scholar ID (40-char hex)

### Opening a paper page in the browser

The reliable way to open an S2 paper page in Chrome is to resolve the identifier to the 40-char paper ID, then open the **website** URL.
The `https://api.semanticscholar.org/...` redirect form is NOT reliable — Chrome often gets a JSON/non-navigable response instead of the rendered page.

```bash
# From a DOI: resolve to paperId, then open the website page
doi="10.1093/sysbio/syy032"
pid=$(curl -s "https://api.semanticscholar.org/graph/v1/paper/DOI:$doi?fields=title" \
  | sed -n 's/.*"paperId": *"\([^"]*\)".*/\1/p')
open -a "Google Chrome" "https://www.semanticscholar.org/paper/$pid"

# If you already have the 40-char SHA paper ID, open it directly:
open -a "Google Chrome" "https://www.semanticscholar.org/paper/<sha>"
```

Note: the bare `https://www.semanticscholar.org/paper/CorpusID:...` form does NOT resolve (404s) — you must use the SHA paper ID.
To resolve a CorpusId instead of a DOI, swap `DOI:$doi` above for `CorpusId:236964352`.

## Troubleshooting

### Snippet Search Timeouts

`pc asta snippet` frequently times out with "context deadline exceeded".
Workarounds:

1. **Reduce limit**: `--limit 5` instead of default
2. **Use MCP directly**: `mcp__asta__snippet_search` with small limit
3. **Fall back to keyword search**: `pc asta search` is more reliable
4. **Retry once** - sometimes it's transient

### No Results Found

If searches return nothing relevant:

1. **Check spelling** of author names and technical terms
2. **Simplify query** - fewer terms, more common synonyms
3. **Try both local and external**:
   ```bash
   pc search "topic" --human # local
   pc asta search "topic"   # external
   ```
4. **Check date filters** - paper may be too old/new for range

### Paper Not Found by ID

If `pc get <id>` or `pc asta paper <id>` fails:

1. **Verify ID format**: `DOI:10.xxxx/yyyy` (include prefix)
2. **Try alternate IDs**: Same paper may have DOI, PMID, arXiv ID
3. **Search by title instead**: `pc asta search "exact paper title"`

### SQL Schema Errors

If you see errors like `no such column: pmid` or similar schema mismatches:

```bash
pc rebuild
```

The SQLite database is ephemeral and rebuilt from the JSONL source of truth.
Schema changes require deleting and rebuilding.

### Slow Performance

- `pc s2` commands are rate-limited to 1 req/sec
- Use `pc asta` for bulk exploration (10 req/sec)
- Run searches in parallel when independent
