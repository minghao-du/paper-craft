/**
 * Workflow evidence discipline and PR body validation module.
 *
 * Enforces the recalibrated Evidence Discipline (EVIDENCE-DISCIPLINE.md):
 * - Code/config/architectural claims must reference files a reader can open in the repository.
 * - Experimental measurements and benchmarks are authoritatively established via
 *   self-contained Markdown summary tables in the PR body, citing reproduction commands,
 *   environment specifications, and computational duration, rather than committing
 *   transient files (models, raw data tables, evaluation plots) or requiring GitHub blob links.
 */

/**
 * Options for evaluating evidence discipline in PR bodies.
 */
export interface PREvidenceValidationOptions {
  /**
   * If true, strictly verifies that experimental sections contain reproduction commands and specs.
   * Defaults to true.
   */
  strictReproductionNotes?: boolean;
}

/**
 * Information extracted from experimental/benchmark claims in a PR body.
 */
export interface ExtractedMeasurementEvidence {
  /** Whether the PR body contains Markdown metric/measurement summary tables. */
  hasMetricTable: boolean;
  /** Whether a reproduction command was cited. */
  hasReproductionCommand: boolean;
  /** Whether computational duration or cost was cited. */
  hasDuration: boolean;
  /** Whether environment or hardware specifications were cited. */
  hasEnvironment: boolean;
  /** Detected reproduction command string, if found. */
  reproductionCommand?: string;
  /** Detected computational duration, if found. */
  duration?: string;
  /** Detected environment specification, if found. */
  environment?: string;
  /** Whether any GitHub blob URLs were included. */
  hasBlobUrls: boolean;
  /** List of detected GitHub blob URLs. */
  blobUrls: string[];
}

/**
 * Outcome of evaluating PR body evidence discipline.
 */
export interface PREvidenceValidationResult {
  /** Whether the PR body satisfies evidence discipline standards. */
  valid: boolean;
  /**
   * Strictly false under recalibrated evidence discipline:
   * experimental benchmarks do NOT require GitHub blob URL links to transient files.
   */
  requiresBlobUrl: boolean;
  /** Extracted evidence details. */
  evidence: ExtractedMeasurementEvidence;
  /** Warnings or guidance notes regarding evidence formatting. */
  notes: string[];
}

/**
 * Regular expression detecting Markdown tables with headers, separator, and data rows.
 */
const MARKDOWN_TABLE_REGEX = /\r?\n\|[^\n]+\|\r?\n\|[\s\-:|]+\|\r?\n(?:\|[^\n]+\|\r?\n?)+/;

/**
 * Regular expression detecting GitHub blob links.
 */
const GITHUB_BLOB_REGEX = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/blob\/[^\s)\]]+/gi;

/**
 * Keywords indicating benchmark or measurement claims in a PR body.
 */
const MEASUREMENT_KEYWORDS = [
  'benchmark',
  'benchmarks',
  'experiment',
  'experiments',
  'accuracy',
  'f1-score',
  'f1 score',
  'latency',
  'throughput',
  'eval results',
  'metric',
  'metrics',
];

/**
 * Evaluates whether a PR body complies with evidence discipline.
 *
 * Verifies that experimental measurements and benchmarks are authoritatively established
 * via self-contained summary tables with reproduction commands, environment specs, and
 * duration, without requiring GitHub blob URL links to transient files.
 *
 * @param prBody - Markdown content of the PR body.
 * @param options - Validation options.
 * @returns Structured validation result.
 */
export function validatePRBodyEvidence(
  prBody: string,
  options: PREvidenceValidationOptions = {}
): PREvidenceValidationResult {
  const strict = options.strictReproductionNotes !== false;
  const notes: string[] = [];

  const lower = prBody.toLowerCase();
  const hasMeasurementClaim = MEASUREMENT_KEYWORDS.some((kw) => lower.includes(kw));

  // 1. Detect Markdown table
  const hasMetricTable = MARKDOWN_TABLE_REGEX.test(prBody);

  // 2. Detect reproduction command
  const cmdMatch = prBody.match(
    /(?:^|\n)\s*[-*]?\s*(?:\*\*)?(?:reproduction command|reproduce with|reproduction|command|eval command|run with)(?:\*\*)?\s*:\s*[`"]?([^`"\r\n]+)[`"]?/im
  );
  const reproductionCommand = cmdMatch?.[1]?.trim();
  const hasReproductionCommand = Boolean(reproductionCommand);

  // 3. Detect duration / compute cost
  const durationMatch = prBody.match(
    /(?:^|\n)\s*[-*]?\s*(?:\*\*)?(?:duration|runtime|elapsed time|took|compute cost|reproduction duration|cost)(?:\*\*)?\s*:\s*[`"]?([^`"\r\n]+)[`"]?/im
  );
  const duration = durationMatch?.[1]?.trim();
  const hasDuration = Boolean(duration);

  // 4. Detect environment specs
  const envMatch = prBody.match(
    /(?:^|\n)\s*[-*]?\s*(?:\*\*)?(?:environment(?: specs)?|env specs|environment specifications|hardware specs|hardware|host|specs)(?:\*\*)?\s*:\s*[`"]?([^`"\r\n]+)[`"]?/im
  );
  const environment = envMatch?.[1]?.trim();
  const hasEnvironment = Boolean(environment);

  // 5. Detect GitHub blob URLs
  const blobMatches = prBody.match(GITHUB_BLOB_REGEX) ?? [];
  const blobUrls = Array.from(new Set(blobMatches));
  const hasBlobUrls = blobUrls.length > 0;

  const evidence: ExtractedMeasurementEvidence = {
    hasMetricTable,
    hasReproductionCommand,
    hasDuration,
    hasEnvironment,
    reproductionCommand,
    duration,
    environment,
    hasBlobUrls,
    blobUrls,
  };

  // Under recalibrated Evidence Discipline (Spec #7 / Issue #8):
  // PR body format checks NEVER require GitHub blob URL links for experimental measurements.
  const requiresBlobUrl = false;

  // If blob URLs are found that point to forbidden output cruft paths, flag them
  const cruftBlobUrls = blobUrls.filter((url) =>
    /(?:output|results|\.joblib|\.pt|\.tsv|\.csv|\.png)/i.test(url)
  );
  if (cruftBlobUrls.length > 0) {
    notes.push(
      `Notice: PR body references GitHub blob URLs to transient files (${cruftBlobUrls.join(', ')}). Transient output artifacts should remain local or quarantined, not committed to git.`
    );
  }

  // If no measurements or benchmarks are mentioned, code-only PR passes cleanly
  if (!hasMeasurementClaim && !hasMetricTable) {
    return {
      valid: true,
      requiresBlobUrl,
      evidence,
      notes,
    };
  }

  // If measurements are claimed:
  let valid = true;

  if (hasMeasurementClaim && !hasMetricTable) {
    if (strict) {
      valid = false;
      notes.push(
        'Experimental measurements or benchmarks claimed without a Markdown summary table. Provide a self-contained summary table in the PR body.'
      );
    }
  }

  if (hasMetricTable) {
    if (!hasReproductionCommand) {
      notes.push('Missing reproduction command for benchmark summary table.');
      if (strict) valid = false;
    }
    if (!hasDuration) {
      notes.push('Missing computational duration or cost for benchmark summary table.');
      if (strict) valid = false;
    }
    if (!hasEnvironment) {
      notes.push('Missing environment or hardware specifications for benchmark summary table.');
      if (strict) valid = false;
    }
  }

  if (valid && hasMetricTable) {
    notes.push(
      'Benchmark results authoritatively verified via self-contained summary table, reproduction command, duration, and environment notes (no GitHub blob URLs required).'
    );
  }

  return {
    valid,
    requiresBlobUrl,
    evidence,
    notes,
  };
}
