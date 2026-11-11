import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('active documentation pairs pass under the aggregate documentation gate', () => {
  const result = spawnSync(process.execPath, [
    '--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/docs/docs-i18n.ts'), 'check',
  ], {
    encoding: 'utf8',
    timeout: 20000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const list = spawnSync(
    process.execPath,
    ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/docs/docs-i18n.ts'), 'list'],
    { encoding: 'utf8', timeout: 10000 },
  );
  for (const file of ['README.md', 'docs/i18n/documentation.md']) {
    expect(list.stdout).toContain(`ok ${file}`);
    expect(list.stdout).not.toContain(`backlog ${file}`);
  }
}, 30000);
