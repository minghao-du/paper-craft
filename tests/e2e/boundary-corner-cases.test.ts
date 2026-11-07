/**
 * Tier 2: Boundary & Corner Cases Tests
 *
 * Verifies error handling, malformed JSON detection, schema boundary enforcement,
 * unicode/special character fidelity, and edge cases.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDir,
  runEnvelopeCli,
  runStateMachineCli,
  type TaskInputEnvelope,
} from './test-helpers.js';

describe('Tier 2: Boundary & Corner Cases', () => {
  let testEnv: { dir: string; cleanup: () => void };

  beforeEach(() => {
    testEnv = createTestDir('tier2-boundary-');
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('B2.1: handles corrupted and truncated JSON envelope files gracefully', () => {
    const corruptedPath = path.join(testEnv.dir, 'corrupted.json');
    fs.writeFileSync(corruptedPath, '{"task": {"logical_stage": "test"'); // Truncated JSON

    const result = runEnvelopeCli(['validate', corruptedPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Corrupted envelope JSON');

    const showResult = runEnvelopeCli(['show', corruptedPath]);
    expect(showResult.status).not.toBe(0);
    expect(showResult.stderr).toContain('Corrupted envelope JSON');
  });

  it('B2.2: rejects non-object JSON roots (arrays, primitives)', () => {
    const arrayEnvelope = path.join(testEnv.dir, 'array.json');
    fs.writeFileSync(arrayEnvelope, JSON.stringify(['item1', 'item2']));

    const result = runEnvelopeCli(['validate', arrayEnvelope]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Root envelope must be a JSON object (dict)');
  });

  it('B2.3: detects and lists all missing required top-level keys', () => {
    const incompletePath = path.join(testEnv.dir, 'incomplete.json');
    fs.writeFileSync(
      incompletePath,
      JSON.stringify({
        schema_version: '1.0',
        task: {
          logical_stage: 'plan',
          step_index: 0,
          attempt: 1,
          root_issue_id: '1',
          current_issue_id: '1',
        },
      }),
    );

    const result = runEnvelopeCli(['validate', incompletePath, '--json']);
    expect(result.status).not.toBe(0);

    const errors: string[] = JSON.parse(result.stdout);
    expect(errors).toContain("Missing required top-level key: 'provider'");
    expect(errors).toContain("Missing required top-level key: 'environment'");
    expect(errors).toContain("Missing required top-level key: 'inputs'");
    expect(errors).toContain("Missing required top-level key: 'contract'");
    expect(errors).toContain("Missing required top-level key: 'budgets'");
  });

  it('B2.4: rejects invalid schema version and bad numeric types', () => {
    const invalidVerPath = path.join(testEnv.dir, 'bad-version.json');
    const dummyReceipt = path.join(testEnv.dir, 'receipt.md');

    // Create a base valid envelope first
    runEnvelopeCli([
      'create',
      '--output', invalidVerPath,
      '--stage', 'stage_1_plan',
      '--step', '1',
      '--root-issue', '1',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-plan',
      '--workdir', testEnv.dir,
      '--objective', 'Version check test',
      '--receipt-path', dummyReceipt,
    ]);

    const data: Record<string, unknown> = JSON.parse(fs.readFileSync(invalidVerPath, 'utf-8'));

    // Inject unsupported schema version
    data.schema_version = '2.0';
    fs.writeFileSync(invalidVerPath, JSON.stringify(data, null, 2));

    const verResult = runEnvelopeCli(['validate', invalidVerPath]);
    expect(verResult.status).not.toBe(0);
    expect(verResult.stderr).toContain("Unsupported schema_version '2.0'. Expected '1.0'");

    // Restore version, inject boolean for integer field
    data.schema_version = '1.0';
    (data.task as Record<string, unknown>).step_index = true;
    fs.writeFileSync(invalidVerPath, JSON.stringify(data, null, 2));

    const boolResult = runEnvelopeCli(['validate', invalidVerPath]);
    expect(boolResult.status).not.toBe(0);
    expect(boolResult.stderr).toContain('[task.step_index] Expected integer >= 0');
  });

  it('B2.5: rejects empty string fields where non-empty string is required', () => {
    const emptyFieldPath = path.join(testEnv.dir, 'empty-field.json');
    const dummyReceipt = path.join(testEnv.dir, 'receipt.md');

    runEnvelopeCli([
      'create',
      '--output', emptyFieldPath,
      '--stage', 'stage_1_plan',
      '--step', '1',
      '--root-issue', '1',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-plan',
      '--workdir', testEnv.dir,
      '--objective', 'Non-empty test',
      '--receipt-path', dummyReceipt,
    ]);

    const data: Record<string, unknown> = JSON.parse(fs.readFileSync(emptyFieldPath, 'utf-8'));
    (data.task as Record<string, unknown>).logical_stage = '   ';
    (data.inputs as Record<string, unknown>).objective = '';
    (data.contract as Record<string, unknown>).receipt_path = '';
    fs.writeFileSync(emptyFieldPath, JSON.stringify(data, null, 2));

    const result = runEnvelopeCli(['validate', emptyFieldPath, '--json']);
    expect(result.status).not.toBe(0);

    const errors: string[] = JSON.parse(result.stdout);
    expect(errors).toContain('[task.logical_stage] Expected non-empty string');
    expect(errors).toContain('[inputs.objective] Expected non-empty string');
    expect(errors).toContain('[contract.receipt_path] Expected non-empty string');
  });

  it('B2.6: preserves Unicode, Chinese characters, newlines, and quotes in inputs', () => {
    const unicodeEnvelopePath = path.join(testEnv.dir, 'unicode-envelope.json');
    const receiptPath = path.join(testEnv.dir, 'receipt.md');

    const complexObjective = '优化 paper-craft 架构设计与代码实现 🚀\nLine 2: "Quotes" & special chars: <>&;$\'!';
    const complexScope = '阶段解耦、Task Input Envelope 上下文文件化';
    const criteria1 = '支持 --input-envelope 驱动脚本执行';
    const criteria2 = '输出回执符合 { execution_status, result, receipt_path, summary }';

    const result = runEnvelopeCli([
      'create',
      '--output', unicodeEnvelopePath,
      '--stage', 'workspace_prepare',
      '--step', '1',
      '--root-issue', '999',
      '--provider-type', 'skill',
      '--provider-target', 'pc-workspace',
      '--workdir', testEnv.dir,
      '--objective', complexObjective,
      '--scope', complexScope,
      '--criteria', criteria1,
      '--criteria', criteria2,
      '--receipt-path', receiptPath,
    ]);

    expect(result.status).toBe(0);
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(unicodeEnvelopePath, 'utf-8'));
    expect(env.inputs.objective).toBe(complexObjective);
    expect(env.inputs.scope).toBe(complexScope);
    expect(env.inputs.acceptance_criteria).toEqual([criteria1, criteria2]);

    const valResult = runEnvelopeCli(['validate', unicodeEnvelopePath]);
    expect(valResult.status).toBe(0);
  });

  it('B2.7: creates parent directories automatically when output path is deeply nested', () => {
    const deepNestedPath = path.join(testEnv.dir, 'a/b/c/d/step-envelope.json');
    const receiptPath = path.join(testEnv.dir, 'receipt.md');

    const result = runEnvelopeCli([
      'create',
      '--output', deepNestedPath,
      '--stage', 'issue_work',
      '--step', '2',
      '--root-issue', '404',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-work',
      '--workdir', testEnv.dir,
      '--objective', 'Deep nested creation',
      '--receipt-path', receiptPath,
    ]);

    expect(result.status).toBe(0);
    expect(fs.existsSync(deepNestedPath)).toBe(true);
  });

  it('B2.8: halts and returns non-zero when requesting non-existent field via show --field', () => {
    const envelopePath = path.join(testEnv.dir, 'envelope.json');
    const receiptPath = path.join(testEnv.dir, 'receipt.md');

    runEnvelopeCli([
      'create',
      '--output', envelopePath,
      '--stage', 'issue_plan',
      '--step', '1',
      '--root-issue', '1',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-plan',
      '--workdir', testEnv.dir,
      '--objective', 'Field check',
      '--receipt-path', receiptPath,
    ]);

    const result = runEnvelopeCli(['show', envelopePath, '--field', 'non.existent.field']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Error: Field 'non.existent.field' not found");
  });

  it('B2.9: state machine check-budget halts when budget limit is reached', () => {
    runStateMachineCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '500',
    ]);

    // Budget starts at 0/3
    const checkOk = runStateMachineCli([
      'check-budget',
      '--receipt-root', testEnv.dir,
      '--type', 'delivery',
      '--limit', '3',
    ]);
    expect(checkOk.status).toBe(0);
    expect(checkOk.stdout).toContain('Budget OK: delivery_attempts_used is 0/3');

    // Increment budget 3 times
    for (let i = 0; i < 3; i++) {
      runStateMachineCli([
        'transition',
        '--receipt-root', testEnv.dir,
        '--stage', 'stage_2_work',
        '--status', 'failed',
        '--incr-budget', 'delivery_attempts_used',
      ]);
    }

    // Now budget is 3/3, which reaches limit
    const checkExceeded = runStateMachineCli([
      'check-budget',
      '--receipt-root', testEnv.dir,
      '--type', 'delivery',
      '--limit', '3',
    ]);
    expect(checkExceeded.status).toBe(1);
    expect(checkExceeded.stderr).toContain('Budget exceeded: delivery_attempts_used is 3, limit is 3');
  });
});
