/**
 * `pc config` — get or set configuration values.
 *
 * Usage:
 *   pc config                            # Show all config
 *   pc config pdf-root                   # Get specific value
 *   pc config pdf-root /path/to/pdfs     # Set value
 *   pc config pdf-reader skim            # Set PDF reader
 *   pc config papers-repo ~/papers       # Set papers repo path
 *
 * Keys:
 *   pdf-root      Path to PDF folder
 *   pdf-reader    PDF reader preference (system, skim, zathura, evince, okular)
 *   papers-repo   Path to papers repository
 */

import { Command } from 'commander';
import {
  mustGetNexusPath,
  loadNexusConfig,
  saveNexusConfig,
  validatePdfReader,
  validateDirectoryPath,
} from '../utils/config.js';
import { output } from '../utils/output.js';

const VALID_KEYS = ['pdf-root', 'pdf-reader', 'papers-repo'] as const;
type ConfigKey = (typeof VALID_KEYS)[number];

/** Normalize a config key to its canonical form. */
function normalizeKey(key: string): ConfigKey {
  const normalized = key.toLowerCase().replace(/_/g, '-') as ConfigKey;
  if (!VALID_KEYS.includes(normalized)) {
    throw new Error(`Unknown config key: ${key} (valid: ${VALID_KEYS.join(', ')})`);
  }
  return normalized;
}

/** Map CLI key names to NexusConfig property names. */
function keyToProp(key: ConfigKey): 'pdf_root' | 'pdf_reader' | 'papers_repo' {
  return key.replace(/-/g, '_') as 'pdf_root' | 'pdf_reader' | 'papers_repo';
}

export function registerConfigCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('config')
    .description('Get or set configuration values')
    .argument('[key]', 'Config key to get or set')
    .argument('[value]', 'Value to set')
    .action((key?: string, value?: string) => {
      const nexusPath = mustGetNexusPath();
      const cfg = loadNexusConfig(nexusPath);

      // Show all
      if (!key) {
        output(cfg, opts.human());
        return;
      }

      const normalized = normalizeKey(key);
      const prop = keyToProp(normalized);

      // Get specific key
      if (value === undefined) {
        const val = cfg[prop] ?? '';
        output({ [normalized]: val }, opts.human(), () => `${normalized}: ${val || '(not set)'}`);
        return;
      }

      // Set value with validation
      if (normalized === 'pdf-reader') {
        validatePdfReader(value);
      }
      if (normalized === 'pdf-root' || normalized === 'papers-repo') {
        validateDirectoryPath(value);
      }

      cfg[prop] = value;
      saveNexusConfig(nexusPath, cfg);
      output(
        { status: 'ok', key: normalized, value },
        opts.human(),
        () => `Set ${normalized} = ${value}`,
      );
    });
}
