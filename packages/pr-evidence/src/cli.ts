#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { landReviewed } from './landing.js';
import { capture, readback, verify, reviewedIdentity } from './evidence.js';

const usage = [
  'Usage: pr-evidence <capture|verify|readback|land> --worktree <absolute path>',
  '  --repository <[HOST/]OWNER/REPO> --pr <number> [--base-remote <name>]',
  '  [--base <branch>] [--branch <branch>] [--head-repository <[HOST/]OWNER/REPO>] [--commit <sha>]',
  '  [--review <absolute path to capture JSON>]',
  'verify and land require --review. land accepts --issue <number>. readback requires --review or all four identity flags:',
  '--base, --branch, --head-repository and --commit.',
].join('\n');

function main(): void {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      worktree: { type: 'string' },
      repository: { type: 'string' },
      pr: { type: 'string' },
      'base-remote': { type: 'string' },
      base: { type: 'string' },
      branch: { type: 'string' },
      'head-repository': { type: 'string' },
      commit: { type: 'string' },
      review: { type: 'string' },
      issue: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const [mode] = positionals;
  if (positionals.length !== 1 || !['capture', 'verify', 'readback', 'land'].includes(mode)
      || !values.worktree || !values.repository || !values.pr || !/^[1-9][0-9]*$/.test(values.pr)) {
    throw new Error(usage);
  }
  if (values.review && (mode === 'capture' || !isAbsolute(values.review))) {
    throw new Error('Use an absolute --review path with verify, readback or land');
  }
  const reviewed = values.review ? reviewedIdentity(JSON.parse(readFileSync(values.review, 'utf8'))) : undefined;
  const options = {
    workingDirectory: values.worktree, repository: values.repository, prNumber: Number(values.pr),
    baseRemote: values['base-remote'], baseBranch: values.base, branch: values.branch,
    headRepository: values['head-repository'], commit: values.commit,
  };
  if (values.issue !== undefined && mode !== 'land') throw new Error('--issue requires land');
  if (mode === 'land') {
    if (!reviewed) throw new Error('land requires --review');
    const result = landReviewed(options, reviewed, values.issue);
    console.log(JSON.stringify(result));
    if (result.outcome !== 'landed') process.exitCode = 1;
    return;
  }
  if (mode === 'verify' && !reviewed) throw new Error('verify requires --review');
  if (mode === 'readback' && !reviewed
      && !(options.baseBranch && options.branch && options.headRepository && options.commit)) {
    throw new Error('readback requires --review or --base, --branch, --head-repository and --commit');
  }
  const result = mode === 'verify' && reviewed ? verify(options, reviewed)
    : mode === 'readback' ? readback(options, reviewed) : capture(options);
  console.log(JSON.stringify(result));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof Error && 'details' in error && error.details) {
    console.error(JSON.stringify(error.details));
  }
  process.exitCode = 1;
}
