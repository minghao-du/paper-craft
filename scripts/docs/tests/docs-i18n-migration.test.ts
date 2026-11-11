import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { REPO_ROOT, TSX_LOADER_PATH } from '../../../tests/support/index.js';

test('active documentation pairs pass under the aggregate documentation gate', () => {
  const script = resolve(REPO_ROOT, 'scripts/docs/docs-i18n.ts');
  const result = spawnSync(process.execPath, [
    '--import', TSX_LOADER_PATH, script, 'check',
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const list = spawnSync(
    process.execPath,
    ['--import', TSX_LOADER_PATH, script, 'list'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 },
  );
  for (const file of ['README.md', 'docs/i18n/documentation.md']) {
    expect(list.stdout).toContain(`ok ${file}`);
    expect(list.stdout).not.toContain(`backlog ${file}`);
  }
}, 30000);
