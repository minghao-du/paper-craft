/**
 * Task Input Envelope & Envelope CLI Feature and Boundary Tests.
 *
 * Verifies core functionality of envelope generation, schema validation,
 * provider decoupling ("skill" vs "script"), budget serialization,
 * state inheritance, as well as boundary and corner cases (B2.1-B2.8).
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
} from './helpers.js';

describe('Task Input Envelope Core Features', () => {
  let testEnv: { dir: string; cleanup: () => void };

  beforeEach(() => {
    testEnv = createTestDir('tier1-envelope-');
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('F1.1: generates complete envelope via CLI and saves atomically', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '42',
      '--delivery-attempts-max', '3',
      '--replans-max', '2',
    ]);

    const result = runPrepareTaskCli(testEnv.dir, {
      stage: 'workspace_prepare',
      objective: 'Prepare feature worktree for issue 42',
      provider: {
        type: 'skill',
        target: 'pc-workspace',
      },
      workdir: testEnv.dir,
      branch: 'issue-42',
      commit: 'abcdef1234567890abcdef1234567890abcdef12',
      scope: 'Isolated worktree creation',
      receipt_template: 'templates/subagent-receipt.template.md',
      acceptance_criteria: ['Worktree directory must exist', 'Branch issue-42 checked out'],
    });

    expect(result.status).toBe(0);
    const prepData = JSON.parse(result.stdout);
    const outputPath = prepData.envelope_path;
    const receiptPath = prepData.receipt_path;
    expect(fs.existsSync(outputPath)).toBe(true);

    const savedContent: TaskInputEnvelope = JSON.parse(
      fs.readFileSync(outputPath, 'utf-8'),
    );

    expect(savedContent.schema_version).toBe('1.0');
    expect(savedContent.task.logical_stage).toBe('workspace_prepare');
    expect(savedContent.task.step_index).toBe(1);
    expect(savedContent.task.root_issue_id).toBe('42');
    expect(savedContent.task.current_issue_id).toBe('42');
    expect(savedContent.provider.type).toBe('skill');
    expect(savedContent.provider.target).toBe('pc-workspace');
    expect(savedContent.environment.working_directory).toBe(
      path.resolve(testEnv.dir),
    );
    expect(savedContent.inputs.objective).toBe(
      'Prepare feature worktree for issue 42',
    );
    expect(savedContent.inputs.acceptance_criteria).toEqual([
      'Worktree directory must exist',
      'Branch issue-42 checked out',
    ]);
    expect(savedContent.contract.receipt_path).toBe(path.resolve(receiptPath));
    expect(savedContent.budgets.delivery_attempts_max).toBe(3);
    expect(savedContent.budgets.replans_max).toBe(2);
  });

  it('F1.2: validate subcommand verifies compliant envelope schema', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '101',
    ]);

    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'issue_plan',
      objective: 'Formulate research plan',
      provider: {
        type: 'skill',
        target: 'pc-issue-plan',
      },
      workdir: testEnv.dir,
    });
    expect(prepRes.status).toBe(0);
    const envelopePath = JSON.parse(prepRes.stdout).envelope_path;

    const valResult = runEnvelopeCli(['validate', envelopePath]);
    expect(valResult.status).toBe(0);
    expect(valResult.stdout).toContain(`Valid envelope: ${path.resolve(envelopePath)}`);

    const jsonValResult = runEnvelopeCli(['validate', envelopePath, '--json']);
    expect(jsonValResult.status).toBe(0);
    expect(JSON.parse(jsonValResult.stdout)).toEqual([]);
  });

  it('F1.3: show subcommand presents compact human-readable and JSON views', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '88',
    ]);

    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'issue_verify',
      objective: 'Run acceptance tests',
      provider: {
        type: 'skill',
        target: 'pc-issue-verify',
      },
      workdir: testEnv.dir,
    });
    expect(prepRes.status).toBe(0);
    const envelopePath = JSON.parse(prepRes.stdout).envelope_path;

    const showText = runEnvelopeCli(['show', envelopePath]);
    expect(showText.status).toBe(0);
    expect(showText.stdout).toContain('Envelope:');
    expect(showText.stdout).toMatch(/Task: (stage_3_verify|issue_verify) \(step 1, attempt 1\)/);
    expect(showText.stdout).toContain('Provider: skill -> pc-issue-verify');

    const showJson = runEnvelopeCli(['show', envelopePath, '--json']);
    expect(showJson.status).toBe(0);
    const parsed = JSON.parse(showJson.stdout);
    expect(parsed.task.logical_stage).toBe('stage_3_verify');
  });

  it('F1.4: show subcommand retrieves nested fields with --field', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '99',
    ]);

    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_4_refactor_execute',
      objective: 'Refactor snakemake rules',
      provider: {
        type: 'skill',
        target: 'pc-pipeline-snakemake',
        args: ['--dry-run'],
      },
      workdir: testEnv.dir,
    });
    expect(prepRes.status).toBe(0);
    const prepData = JSON.parse(prepRes.stdout);
    const envelopePath = prepData.envelope_path;
    const receiptPath = prepData.receipt_path;

    const stageField = runEnvelopeCli([
      'show', envelopePath,
      '--field', 'task.logical_stage',
    ]);
    expect(stageField.status).toBe(0);
    expect(stageField.stdout.trim()).toBe('stage_4_refactor_execute');

    const receiptField = runEnvelopeCli([
      'show', envelopePath,
      '--field', 'contract.receipt_path',
    ]);
    expect(receiptField.status).toBe(0);
    expect(receiptField.stdout.trim()).toBe(path.resolve(receiptPath));

    const providerArgsField = runEnvelopeCli([
      'show', envelopePath,
      '--field', 'provider.args',
    ]);
    expect(providerArgsField.status).toBe(0);
    expect(JSON.parse(providerArgsField.stdout)).toEqual(['--dry-run']);
  });

  it('F1.5: budgets and limits are correctly serialized and bounded', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '200',
      '--delivery-attempts-max', '5',
      '--replans-max', '3',
    ]);

    const result = runPrepareTaskCli(testEnv.dir, {
      stage: 'issue_work',
      objective: 'Implement feature X',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      workdir: testEnv.dir,
    });

    expect(result.status).toBe(0);
    const envelopePath = JSON.parse(result.stdout).envelope_path;
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.budgets.delivery_attempts_used).toBe(1);
    expect(env.budgets.delivery_attempts_max).toBe(5);
    expect(env.budgets.replans_used).toBe(0);
    expect(env.budgets.replans_max).toBe(3);
  });

  it('F1.6: populates context and predecessor receipts across stages', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '300',
      '--current-issue', '301',
    ]);

    const prep1 = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_1_plan',
      objective: 'Plan issue 301',
      provider: {
        type: 'skill',
        target: 'pc-issue-plan',
      },
      workdir: testEnv.dir,
    });
    expect(prep1.status).toBe(0);
    const prepData1 = JSON.parse(prep1.stdout);

    runLifecycleKernelCli([
      'handoff',
      '--receipt-root', testEnv.dir,
      '--dispatch-id', prepData1.dispatch_id,
    ]);

    fs.writeFileSync(prepData1.receipt_path, '# Plan Receipt\nStatus: completed');

    const compRes = runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--dispatch-id', prepData1.dispatch_id,
      '--report', JSON.stringify({
        execution_status: 'succeeded',
        result: { outcome: 'planned' },
        receipt_path: prepData1.receipt_path,
        summary: 'Planned child issue 301',
      }),
    ]);
    expect(compRes.status).toBe(0);

    const result = runPrepareTaskCli(testEnv.dir, {
      stage: 'issue_work',
      objective: 'Implement child issue 301',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      workdir: testEnv.dir,
      branch: 'issue-301',
      commit: '1234567890123456789012345678901234567890',
      predecessor_receipts: [prepData1.receipt_path],
    });

    expect(result.status).toBe(0);
    const envelopePath = JSON.parse(result.stdout).envelope_path;
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.task.logical_stage).toBe('stage_2_work');
    expect(env.task.root_issue_id).toBe('300');
    expect(env.task.current_issue_id).toBe('301');
    expect(env.environment.working_directory).toBe(path.resolve(testEnv.dir));
    expect(env.environment.branch).toBe('issue-301');
    expect(env.environment.commit).toBe('1234567890123456789012345678901234567890');
    expect(env.inputs.predecessor_receipts).toContain(prepData1.receipt_path);
    expect(env.budgets.delivery_attempts_used).toBe(1);
  });
});

describe('Stage-Provider Decoupling Core Features', () => {
  let testEnv: { dir: string; cleanup: () => void };

  beforeEach(() => {
    testEnv = createTestDir('tier1-provider-');
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('F2.1: configures provider type "skill" targeting skill directory', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '50',
    ]);
    const result = runPrepareTaskCli(testEnv.dir, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace via skill',
      provider: {
        type: 'skill',
        target: 'pc-workspace',
      },
      workdir: testEnv.dir,
    });

    expect(result.status).toBe(0);
    const envelopePath = JSON.parse(result.stdout).envelope_path;
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.provider.type).toBe('skill');
    expect(env.provider.target).toBe('pc-workspace');
    expect(env.provider.args).toEqual([]);
  });

  it('F2.2: rejects provider type "script" as unsupported', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '50',
    ]);
    const result = runPrepareTaskCli(testEnv.dir, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace via script kernel',
      provider: {
        type: 'script',
        target: 'packages/workspace/src/cli.ts',
        args: ['--issue', '50'],
      },
      workdir: testEnv.dir,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Provider 'type' must be 'skill'");
  });

  it('F2.3: rejects unsupported provider types with schema validation error', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '60',
    ]);
    const result = runPrepareTaskCli(testEnv.dir, {
      stage: 'issue_work',
      objective: 'Test invalid provider',
      provider: {
        type: 'plugin',
        target: 'custom-plugin',
      },
      workdir: testEnv.dir,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Provider 'type' must be 'skill'");
  });

  it('F2.4: preserves multiple ordered provider arguments', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '70',
    ]);
    const result = runPrepareTaskCli(testEnv.dir, {
      stage: 'issue_verify',
      objective: 'Run verification script',
      provider: {
        type: 'skill',
        target: 'pc-issue-verify',
        args: [
          '--suite=e2e', '--timeout=60', '--strict', '--repo-dir',
          '/tmp/path with spaces', '', '--', "a'b\"c", '--strict',
        ],
      },
      workdir: testEnv.dir,
    });

    expect(result.status).toBe(0);
    const envelopePath = JSON.parse(result.stdout).envelope_path;
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.provider.args).toEqual([
      '--suite=e2e', '--timeout=60', '--strict', '--repo-dir',
      '/tmp/path with spaces', '', '--', "a'b\"c", '--strict',
    ]);
  });

  it('F2.5: envelope schema remains identical across skill targets and stages', () => {
    const rootSkill1 = path.join(testEnv.dir, 'skill-run-1');
    runLifecycleKernelCli(['init', '--receipt-root', rootSkill1, '--root-issue', '80']);
    const prepSkill1 = runPrepareTaskCli(rootSkill1, {
      stage: 'issue_plan',
      objective: 'Planning stage with skill',
      provider: {
        type: 'skill',
        target: 'pc-issue-plan',
      },
      workdir: testEnv.dir,
    });
    const skill1EnvPath = JSON.parse(prepSkill1.stdout).envelope_path;

    const rootSkill2 = path.join(testEnv.dir, 'skill-run-2');
    runLifecycleKernelCli(['init', '--receipt-root', rootSkill2, '--root-issue', '80']);
    const prepSkill2 = runPrepareTaskCli(rootSkill2, {
      stage: 'issue_work',
      objective: 'Working stage with skill',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      workdir: testEnv.dir,
    });
    const skill2EnvPath = JSON.parse(prepSkill2.stdout).envelope_path;

    const env1: TaskInputEnvelope = JSON.parse(fs.readFileSync(skill1EnvPath, 'utf-8'));
    const env2: TaskInputEnvelope = JSON.parse(fs.readFileSync(skill2EnvPath, 'utf-8'));

    // The task structure, environment structure, contract structure and schema version are invariant
    expect(env1.schema_version).toBe(env2.schema_version);
    expect(env1.budgets).toEqual(env2.budgets);
    expect(Object.keys(env1)).toEqual(Object.keys(env2));
  }, 20000);
});

describe('Envelope Boundary & Corner Cases (B2.1-B2.8)', () => {
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
});
