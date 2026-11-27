#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { capture, readback, verify, reviewedIdentity } from './evidence.js';

const usage = [
  'Usage: pr-evidence <capture|verify|readback> --worktree <absolute path>',
  '  --repository <[HOST/]OWNER/REPO> --pr <number> [--base-remote <name>]',
  '  [--base <branch>] [--branch <branch>] [--head-repository <[HOST/]OWNER/REPO>] [--commit <sha>]',
  '  [--review <absolute path to capture JSON>]',
  'verify requires --review. readback requires --review or all four identity flags:',
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
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const [mode] = positionals;
  if (positionals.length !== 1 || !['capture', 'verify', 'readback'].includes(mode)
      || !values.worktree || !values.repository || !values.pr || !/^[1-9][0-9]*$/.test(values.pr)) {
    throw new Error(usage);
  }
  if (values.review && (mode === 'capture' || !isAbsolute(values.review))) {
    throw new Error('Use an absolute --review path with verify or readback');
  }
  const reviewed = values.review ? reviewedIdentity(JSON.parse(readFileSync(values.review, 'utf8'))) : undefined;
  const options = {
    workingDirectory: values.worktree, repository: values.repository, prNumber: Number(values.pr),
    baseRemote: values['base-remote'], baseBranch: values.base, branch: values.branch,
    headRepository: values['head-repository'], commit: values.commit,
  };
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
