import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

// Failure mode: lenient parsing (parseInt('12abc'), ignored unknown flags, last-wins
// duplicates) lets malformed invocations reach Git/receipt side effects.
describe('workspace CLI strict argument parsing', () => {
  let tmp: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cli-test-'));
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const bad: string[][] = [
    ['bogus'],
    ['prepare', 'extra'],
    ['prepare', '--nope'],
    ['prepare', '--issue'],
    ['prepare', '--issue', '--branch', 'x'],
    ['prepare', '--issue', '12abc'],
    ['prepare', '--issue', '0'],
    ['prepare', '--issue', '-1'],
    ['prepare', '--issue', '1.5'],
    ['prepare', '--issue', ''],
    ['prepare', '--issue', '99999999999999999999'],
    ['prepare', '--output-format', 'xml'],
    ['prepare', '--branch', 'a', '--branch', 'b'],
    ['prepare', '--input', 'a.json', '--input-envelope', 'b.json'],
    ['prepare', '--cleanup'],
  ];

  it.each(bad)('rejects %j with no side effects', async (...argv) => {
    const receipt = path.join(tmp, 'receipt.md');
    const code = await main([...argv, '--repo-dir', path.join(tmp, 'missing'), '--receipt-path', receipt]);
    expect(code).not.toBe(0);
    expect(fs.existsSync(receipt)).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
  });

  it('help returns 0 without receipts', async () => {
    const receipt = path.join(tmp, 'receipt.md');
    expect(await main(['prepare', '--receipt-path', receipt, '--help'])).toBe(0);
    expect(logSpy).toHaveBeenCalled();
    expect(fs.existsSync(receipt)).toBe(false);
  });

  it('cleanup CLI with malformed candidate flag exits non-zero with no side effects', async () => {
    const envelopePath = path.join(tmp, 'bad-cleanup-envelope.json');
    const receiptPath = path.join(tmp, 'receipt.md');
    const envelope = {
      schema_version: '1.0',
      task: { logical_stage: 'workspace_cleanup', root_issue_id: '99' },
      environment: { working_directory: tmp },
      inputs: {
        parameters: {
          candidates: [
            {
              branch: 'issue-99',
              created: 'false',
            },
          ],
        },
      },
      contract: { receipt_path: receiptPath },
    };
    fs.writeFileSync(envelopePath, JSON.stringify(envelope));

    const code = await main([
      'cleanup',
      '--input-envelope',
      envelopePath,
      '--repo-dir',
      tmp,
      '--receipt-path',
      receiptPath,
    ]);

    expect(code).not.toBe(0);
    expect(errSpy).toHaveBeenCalled();
    expect(fs.existsSync(receiptPath)).toBe(false);
  });
});
