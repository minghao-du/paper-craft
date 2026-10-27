/**
 * Scenario 4: Evidence Discipline Validation Test.
 *
 * Verifies that:
 * 1. PR body formatting checks accept Markdown metric summary tables with
 *    reproduction commands, computational duration, and environment notes
 *    without requiring GitHub blob URL links to transient files.
 * 2. Distinguishes code/config claims from experimental measurement claims
 *    per EVIDENCE-DISCIPLINE.md.
 * 3. Flags benchmark claims that lack reproduction commands or environment specs.
 * 4. Ensures contract compliance with skills/pc-issue-work/SKILL.md Step 7.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validatePRBodyEvidence,
  type PREvidenceValidationResult,
} from '@paper-craft/core/workflow/evidence-discipline';

describe('Evidence Discipline: Scenario 4 Validation', () => {
  it('accepts PR body with markdown metric summary tables, reproduction commands, duration, and environment notes without requiring GitHub blob URL links', () => {
    const validPRBody = `
## Summary
- Implemented accelerated tokenizer kernel improving batch inference latency by 35%.
- Closes #123.

## Benchmark Results

| Model | Baseline Latency | Optimized Latency | Speedup | Peak RAM |
| :--- | :--- | :--- | :--- | :--- |
| bert-base | 42.1 ms | 27.3 ms | 1.54x | 1.8 GB |
| roberta-large | 118.4 ms | 76.9 ms | 1.54x | 3.2 GB |

- Reproduction command: \`pnpm run bench:inference --model bert-base --batch-size 32\`
- Duration: 3m 45s across 100 iterations
- Environment: Apple M2 Max, 32GB Unified Memory, macOS 14.5
- Preserved local outputs: \`$CLONE_ROOT/.preserved/bench-123/\` with logs and run README

## Test plan
- pnpm test
- pnpm run typecheck
`;

    const result: PREvidenceValidationResult = validatePRBodyEvidence(validPRBody);

    // Assert: PR body is fully valid
    expect(result.valid).toBe(true);

    // Assert: evidence discipline contract: NEVER requires GitHub blob URL links
    expect(result.requiresBlobUrl).toBe(false);

    // Assert: extracted elements match
    expect(result.evidence.hasMetricTable).toBe(true);
    expect(result.evidence.hasReproductionCommand).toBe(true);
    expect(result.evidence.hasDuration).toBe(true);
    expect(result.evidence.hasEnvironment).toBe(true);
    expect(result.evidence.hasBlobUrls).toBe(false);
    expect(result.evidence.reproductionCommand).toContain('pnpm run bench:inference');
    expect(result.evidence.duration).toContain('3m 45s');
    expect(result.evidence.environment).toContain('Apple M2 Max');

    // Assert: authoritative confirmation in notes
    expect(result.notes.some((n) => n.includes('no GitHub blob URLs required'))).toBe(true);
  });

  it('passes code-only PR bodies cleanly without demanding measurement tables', () => {
    const codeOnlyPRBody = `
## Summary
- Refactored JSONL storage adapter to improve cache eviction ordering.
- Closes #45.

## Test plan
- pnpm test
`;

    const result = validatePRBodyEvidence(codeOnlyPRBody);

    expect(result.valid).toBe(true);
    expect(result.requiresBlobUrl).toBe(false);
    expect(result.evidence.hasMetricTable).toBe(false);
  });

  it('flags benchmark claims missing reproduction command or environment specifications', () => {
    const incompletePRBody = `
## Summary
- Evaluated model accuracy.

## Benchmark Results
| Metric | Score |
| :--- | :--- |
| Accuracy | 94.2% |

(Missing reproduction command, duration, and hardware specs)
`;

    const result = validatePRBodyEvidence(incompletePRBody, { strictReproductionNotes: true });

    expect(result.valid).toBe(false);
    expect(result.requiresBlobUrl).toBe(false);
    expect(result.evidence.hasMetricTable).toBe(true);
    expect(result.evidence.hasReproductionCommand).toBe(false);
    expect(result.evidence.hasDuration).toBe(false);
    expect(result.evidence.hasEnvironment).toBe(false);

    expect(result.notes.some((n) => n.includes('Missing reproduction command'))).toBe(true);
    expect(result.notes.some((n) => n.includes('Missing computational duration'))).toBe(true);
    expect(result.notes.some((n) => n.includes('Missing environment'))).toBe(true);
  });

  it('notices and flags transient output artifact blob URLs in PR body', () => {
    const prBodyWithCruftBlob = `
## Summary
- Generated evaluation models.

## Metrics
| Task | Result |
| :--- | :--- |
| BLEU | 34.2 |

- Command: \`python eval.py\`
- Duration: 12m
- Environment: Ubuntu 22.04, 1x NVIDIA A100

Artifacts committed at: https://github.com/example/repo/blob/main/output/model.joblib
`;

    const result = validatePRBodyEvidence(prBodyWithCruftBlob);

    expect(result.evidence.hasBlobUrls).toBe(true);
    expect(result.evidence.blobUrls).toContain('https://github.com/example/repo/blob/main/output/model.joblib');
    expect(result.notes.some((n) => n.includes('transient files'))).toBe(true);
  });

  it('verifies that EVIDENCE-DISCIPLINE.md and pc-issue-work SKILL.md align on self-contained PR summaries', async () => {
    const evidencePath = join(process.cwd(), 'EVIDENCE-DISCIPLINE.md');
    const evidenceContent = await readFile(evidencePath, 'utf-8');

    // Asserts distinction between code and experimental measurements
    expect(evidenceContent).toContain('Distinguish code and configuration assertions from experimental measurements:');
    expect(evidenceContent).toContain('authoritatively record evidence via self-contained summary tables in the PR body');
    expect(evidenceContent).toContain('citing reproduction commands, environment specs, and computational duration');
    expect(evidenceContent).toContain('rather than committing transient output files');

    // Asserts pc-issue-work SKILL.md Step 7 includes the local outputs and reproduction cost instructions
    const skillPath = join(process.cwd(), 'skills', 'pc-issue-work', 'SKILL.md');
    const skillContent = await readFile(skillPath, 'utf-8');

    expect(skillContent).toContain('When transient local outputs or benchmarks were produced, record in the PR body');
    expect(skillContent).toContain('reproduction command, environment specifications, and reproduction duration or cost');
  });
});
