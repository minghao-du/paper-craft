import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import cleanupRules from '../../../skills/pc-pipeline-snakemake/references/workspace-cleanup.json' with { type: 'json' };
import { normalizeRelativePathList } from './config.js';

function usesStandardOutputLayout(primaryCheckout: string): boolean {
  if (!fs.statSync(path.join(primaryCheckout, 'workflow/Snakefile'), { throwIfNoEntry: false })?.isFile()) {
    return false;
  }

  let settings: Record<string, unknown> | null;
  try {
    settings = parse(fs.readFileSync(path.join(primaryCheckout, 'config/config.yaml'), 'utf8'));
  } catch {
    return false;
  }

  return Object.entries(cleanupRules).every(([setting, rule]) => {
    const root = settings?.[setting];
    return typeof root === 'string' && root.replace(/^(?:\.\/)+|\/+$/g, '') === rule.slice(0, -2);
  });
}

/** Prepare a read-only cleanup proposal. Confirm other standard layouts from project evidence. */
export function prepareSnakemakeCleanup<T extends Record<string, unknown>>(
  primaryCheckout: string,
  config: T,
  { standardLayoutConfirmed = false } = {},
): { draft: T; addedCleanupRules: string[] } {
  if (!standardLayoutConfirmed && !usesStandardOutputLayout(primaryCheckout)) {
    return { draft: config, addedCleanupRules: [] };
  }

  const existing = config.cleanable_ignored === undefined ? [] : config.cleanable_ignored;
  const { items, errors } = normalizeRelativePathList(existing, 'cleanable_ignored', { allowGlobs: true });
  if (!Array.isArray(existing) || errors.length) {
    return { draft: config, addedCleanupRules: [] };
  }

  const addedCleanupRules = Object.values(cleanupRules).filter((rule) => !items.includes(rule));
  const draft = addedCleanupRules.length
    ? { ...config, cleanable_ignored: [...existing, ...addedCleanupRules] }
    : config;
  return { draft, addedCleanupRules };
}
