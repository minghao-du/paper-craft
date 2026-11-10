/**
 * Tier 1 Feature Tests: Task Input Envelope & Stage-Provider Decoupling
 *
 * Verifies core functionality of envelope generation, schema validation,
 * provider decoupling ("skill" vs "script"), budget serialization,
 * and state inheritance.
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

describe('Tier 1: Task Input Envelope Core Features', () => {
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
    expect(showText.stdout).toContain('Task: issue_verify (step 1, attempt 1)');
    expect(showText.stdout).toContain('Provider: skill -> pc-issue-verify');

    const showJson = runEnvelopeCli(['show', envelopePath, '--json']);
    expect(showJson.status).toBe(0);
    const parsed = JSON.parse(showJson.stdout);
    expect(parsed.task.logical_stage).toBe('issue_verify');
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
    expect(env.budgets.delivery_attempts_limit).toBe(5);
    expect(env.budgets.replans_used).toBe(0);
    expect(env.budgets.replans_max).toBe(3);
    expect(env.budgets.replans_limit).toBe(3);
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
    ]);

    fs.writeFileSync(prepData1.receipt_path, '# Plan Receipt\nStatus: completed');

    const compRes = runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
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
    });

    expect(result.status).toBe(0);
    const envelopePath = JSON.parse(result.stdout).envelope_path;
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.task.logical_stage).toBe('issue_work');
    expect(env.task.root_issue_id).toBe('300');
    expect(env.task.current_issue_id).toBe('301');
    expect(env.environment.working_directory).toBe(path.resolve(testEnv.dir));
    expect(env.environment.branch).toBe('issue-301');
    expect(env.environment.commit).toBe('1234567890123456789012345678901234567890');
    expect(env.inputs.predecessor_receipts).toContain(prepData1.receipt_path);
    expect(env.budgets.delivery_attempts_used).toBe(1);
  });
});

describe('Tier 1: Stage-Provider Decoupling Core Features', () => {
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
        target: 'skills/pc-workspace/scripts/prepare-worktree.py',
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
  });
});
