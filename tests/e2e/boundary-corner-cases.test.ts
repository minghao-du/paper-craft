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
  runLifecycleKernelCli,
  runPrepareTaskCli,
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
    const rootB24 = path.join(testEnv.dir, 'b24');
    runLifecycleKernelCli(['init', '--receipt-root', rootB24, '--root-issue', '1']);
    const prepRes = runPrepareTaskCli(rootB24, {
      stage: 'stage_1_plan',
      objective: 'Version check test',
      provider: {
        type: 'skill',
        target: 'pc-issue-plan',
      },
      workdir: testEnv.dir,
    });
    const invalidVerPath = JSON.parse(prepRes.stdout).envelope_path;

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
    const rootB25 = path.join(testEnv.dir, 'b25');
    runLifecycleKernelCli(['init', '--receipt-root', rootB25, '--root-issue', '1']);
    const prepRes = runPrepareTaskCli(rootB25, {
      stage: 'stage_1_plan',
      objective: 'Non-empty test',
      provider: {
        type: 'skill',
        target: 'pc-issue-plan',
      },
      workdir: testEnv.dir,
    });
    const emptyFieldPath = JSON.parse(prepRes.stdout).envelope_path;

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
    const rootB26 = path.join(testEnv.dir, 'b26');
    runLifecycleKernelCli(['init', '--receipt-root', rootB26, '--root-issue', '999']);

    const complexObjective = '优化 paper-craft 架构设计与代码实现 🚀\nLine 2: "Quotes" & special chars: <>&;$\'!';
    const complexScope = '阶段解耦、Task Input Envelope 上下文文件化';
    const criteria1 = '支持 --input-envelope 驱动脚本执行';
    const criteria2 = '输出回执符合 { execution_status, result, receipt_path, summary }';

    const result = runPrepareTaskCli(rootB26, {
      stage: 'workspace_prepare',
      objective: complexObjective,
      provider: {
        type: 'skill',
        target: 'pc-workspace',
      },
      workdir: testEnv.dir,
      scope: complexScope,
      acceptance_criteria: [criteria1, criteria2],
    });

    expect(result.status).toBe(0);
    const unicodeEnvelopePath = JSON.parse(result.stdout).envelope_path;
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(unicodeEnvelopePath, 'utf-8'));
    expect(env.inputs.objective).toBe(complexObjective);
    expect(env.inputs.scope).toBe(complexScope);
    expect(env.inputs.acceptance_criteria).toEqual([criteria1, criteria2]);

    const valResult = runEnvelopeCli(['validate', unicodeEnvelopePath]);
    expect(valResult.status).toBe(0);
  });

  it('B2.7: creates parent directories automatically when output path is deeply nested', () => {
    const deepReceiptRoot = path.join(testEnv.dir, 'a/b/c/d');
    runLifecycleKernelCli(['init', '--receipt-root', deepReceiptRoot, '--root-issue', '404']);
    const result = runPrepareTaskCli(deepReceiptRoot, {
      stage: 'issue_work',
      objective: 'Deep nested creation',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      workdir: testEnv.dir,
    });

    expect(result.status).toBe(0);
    const deepNestedPath = JSON.parse(result.stdout).envelope_path;
    expect(fs.existsSync(deepNestedPath)).toBe(true);
  });

  it('B2.8: halts and returns non-zero when requesting non-existent field via show --field', () => {
    const rootB28 = path.join(testEnv.dir, 'b28');
    runLifecycleKernelCli(['init', '--receipt-root', rootB28, '--root-issue', '1']);
    const prepRes = runPrepareTaskCli(rootB28, {
      stage: 'issue_plan',
      objective: 'Field check',
      provider: {
        type: 'skill',
        target: 'pc-issue-plan',
      },
      workdir: testEnv.dir,
    });
    const envelopePath = JSON.parse(prepRes.stdout).envelope_path;

    const result = runEnvelopeCli(['show', envelopePath, '--field', 'non.existent.field']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Error: Field 'non.existent.field' not found");
  });

  it('B2.9: state machine check-budget halts when budget limit is reached', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '500',
      '--delivery-attempts-max', '3',
    ]);

    // Budget starts at 0/3
    const checkOk = runLifecycleKernelCli([
      'inspect',
      '--receipt-root', testEnv.dir,
      '--json',
    ]);
    expect(checkOk.status).toBe(0);
    const checkOkData = JSON.parse(checkOk.stdout);
    expect(checkOkData.budgets.delivery_attempts_used).toBe(0);
    expect(checkOkData.blocking_reasons).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/delivery attempt budget exhausted/i),
      ]),
    );

    // Attempt 1
    const p1 = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_work',
      objective: 'Task 1',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
    });
    const p1Data = JSON.parse(p1.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir]);
    fs.writeFileSync(p1Data.receipt_path, '# Receipt 1');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--report', JSON.stringify({
        execution_status: 'failed',
        result: {},
        receipt_path: p1Data.receipt_path,
        summary: 'Attempt 1 failed',
      }),
    ]);

    // Attempt 2
    const p2 = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_work',
      objective: 'Task 1',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      attempt_intent: 'new',
    });
    const p2Data = JSON.parse(p2.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir]);
    fs.writeFileSync(p2Data.receipt_path, '# Receipt 2');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--report', JSON.stringify({
        execution_status: 'failed',
        result: {},
        receipt_path: p2Data.receipt_path,
        summary: 'Attempt 2 failed',
      }),
    ]);

    // Attempt 3
    const p3 = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_work',
      objective: 'Task 1',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      attempt_intent: 'new',
    });
    const p3Data = JSON.parse(p3.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir]);
    fs.writeFileSync(p3Data.receipt_path, '# Receipt 3');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--report', JSON.stringify({
        execution_status: 'failed',
        result: {},
        receipt_path: p3Data.receipt_path,
        summary: 'Attempt 3 failed',
      }),
    ]);

    // Now budget is 3/3, which reaches limit
    const checkExceeded = runLifecycleKernelCli([
      'inspect',
      '--receipt-root', testEnv.dir,
      '--json',
    ]);
    expect(checkExceeded.status).toBe(0);
    const checkExceededData = JSON.parse(checkExceeded.stdout);
    expect(checkExceededData.budgets.delivery_attempts_used).toBe(3);
    expect(checkExceededData.blocking_reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/delivery attempt budget exhausted/i),
      ]),
    );
  });
});
