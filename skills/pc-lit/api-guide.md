# S2 vs ASTA API Guide

Both `pc s2` and `pc asta` commands access Semantic Scholar's paper database, but through different APIs with different capabilities.

## Quick Comparison

| Feature | `pc s2` | `pc asta` |
|---------|---------|-----------|
| API | Semantic Scholar REST | Allen AI ASTA MCP |
| Rate limit | 1 req/sec | 10 req/sec |
| Snippet search | No | Yes |
| Add to collection | Yes | No (read-only) |
| Auth | ASTA_API_KEY (shared key) | ASTA_API_KEY |

## When to Use S2

Use `pc s2` when you need to **modify your local collection**:

```bash
# Add a paper to your collection
pc s2 add DOI:10.1093/sysbio/syy032

# Look up paper info (slower, 1 req/sec)
pc s2 lookup DOI:10.1093/sysbio/syy032

# Find citing papers
pc s2 citations <paper-id>

# Find referenced papers
pc s2 references <paper-id>

# Find literature gaps (papers cited by collection but not in it)
pc s2 gaps
```

**Key S2 capabilities**:
- `pc s2 add` - Add papers to your local collection
- `pc s2 gaps` - Analyze your collection for missing papers

## When to Use ASTA

Use `pc asta` for **fast, read-only exploration**:

```bash
# Fast paper search (10x faster rate limit)
pc asta search "phylogenetic inference" --limit 20 --human

# UNIQUE: Search text snippets within papers
pc asta snippet "variational inference" --human

# Get paper details
pc asta paper DOI:10.1093/sysbio/syy032 --human

# Get citations (faster than S2)
pc asta citations DOI:10.1093/sysbio/syy032 --human

# Get references
pc asta references DOI:10.1093/sysbio/syy032 --human

# Search for authors
pc asta author "Frederick Matsen" --human

# Get author's papers
pc asta author-papers 145666442 --human
```

**Key ASTA capabilities**:
- `pc asta snippet` - Search actual text within papers (unique to ASTA)
  - **Note**: Snippet search can be slow and may timeout. Use `--limit 5` or fall back to keyword search if it fails.
- 10x faster rate limit for bulk exploration
- Author search functionality

## ASTA MCP Tools

When using Claude Code, you can also access ASTA directly via MCP tools:

| MCP Tool | Equivalent CLI |
|----------|---------------|
| `mcp__asta__search_papers_by_relevance` | `pc asta search` |
| `mcp__asta__search_paper_by_title` | `pc asta search` (by title) |
| `mcp__asta__snippet_search` | `pc asta snippet` |
| `mcp__asta__get_paper` | `pc asta paper` |
| `mcp__asta__get_citations` | `pc asta citations` |
| `mcp__asta__search_authors_by_name` | `pc asta author` |
| `mcp__asta__get_author_papers` | `pc asta author-papers` |

## Paper ID Formats

Both APIs accept the same identifier formats:

| Format | Example |
|--------|---------|
| DOI | `DOI:10.1093/sysbio/syy032` |
| arXiv | `ARXIV:2106.15928` |
| PubMed | `PMID:19872477` |
| PubMed Central | `PMCID:2323736` |
| Corpus ID | `CorpusId:215416146` |
| Raw S2 ID | `649def34f8be52c8b66281af98ae884c09aef38b` |
| URL | `URL:https://arxiv.org/abs/2106.15928v1` |

## Output Format

Both command families output JSON by default. Add `--human` for readable output:

```bash
pc s2 lookup DOI:10.1093/sysbio/syy032 --human
pc asta search "phylogenetics" --human
```

## Environment Variables

```bash
# In .env file
ASTA_API_KEY=your_asta_api_key  # For both pc s2 and pc asta commands
```

## Decision Flowchart

```
Want to modify your collection?
├── Yes → Use pc s2
│   ├── Add paper → pc s2 add
│   └── Find gaps → pc s2 gaps
└── No (read-only exploration)
    ├── Need text snippets? → pc asta snippet
    ├── Bulk search? → pc asta search (faster)
    ├── Author info? → pc asta author
    └── Citations/refs → pc asta (faster)
```
