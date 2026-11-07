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
    const outputPath = path.join(testEnv.dir, 'step-1-input.json');
    const receiptPath = path.join(testEnv.dir, 'step-1-receipt.md');

    const result = runEnvelopeCli([
      'create',
      '--output', outputPath,
      '--stage', 'workspace_prepare',
      '--step', '1',
      '--attempt', '1',
      '--root-issue', '42',
      '--current-issue', '42',
      '--provider-type', 'skill',
      '--provider-target', 'pc-workspace',
      '--workdir', testEnv.dir,
      '--repository', 'test-owner/test-repo',
      '--base-branch', 'main',
      '--branch', 'issue-42',
      '--commit', 'abcdef1234567890abcdef1234567890abcdef12',
      '--objective', 'Prepare feature worktree for issue 42',
      '--scope', 'Isolated worktree creation',
      '--criteria', 'Worktree directory must exist',
      '--criteria', 'Branch issue-42 checked out',
      '--receipt-path', receiptPath,
      '--receipt-template', 'templates/subagent-receipt.template.md',
      '--delivery-attempts-max', '3',
      '--replans-max', '2',
    ]);

    expect(result.status).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(true);

    const savedContent: TaskInputEnvelope = JSON.parse(
      fs.readFileSync(outputPath, 'utf-8'),
    );
    const stdoutContent: TaskInputEnvelope = JSON.parse(result.stdout);

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

    expect(stdoutContent).toEqual(savedContent);
  });

  it('F1.2: validate subcommand verifies compliant envelope schema', () => {
    const envelopePath = path.join(testEnv.dir, 'valid-envelope.json');
    const receiptPath = path.join(testEnv.dir, 'receipt.md');

    runEnvelopeCli([
      'create',
      '--output', envelopePath,
      '--stage', 'issue_plan',
      '--step', '0',
      '--root-issue', '101',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-plan',
      '--workdir', testEnv.dir,
      '--objective', 'Formulate research plan',
      '--receipt-path', receiptPath,
    ]);

    const valResult = runEnvelopeCli(['validate', envelopePath]);
    expect(valResult.status).toBe(0);
    expect(valResult.stdout).toContain(`Valid envelope: ${path.resolve(envelopePath)}`);

    const jsonValResult = runEnvelopeCli(['validate', envelopePath, '--json']);
    expect(jsonValResult.status).toBe(0);
    expect(JSON.parse(jsonValResult.stdout)).toEqual([]);
  });

  it('F1.3: show subcommand presents compact human-readable and JSON views', () => {
    const envelopePath = path.join(testEnv.dir, 'show-envelope.json');
    const receiptPath = path.join(testEnv.dir, 'show-receipt.md');

    runEnvelopeCli([
      'create',
      '--output', envelopePath,
      '--stage', 'issue_verify',
      '--step', '3',
      '--root-issue', '88',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-verify',
      '--workdir', testEnv.dir,
      '--objective', 'Run acceptance tests',
      '--receipt-path', receiptPath,
    ]);

    const showText = runEnvelopeCli(['show', envelopePath]);
    expect(showText.status).toBe(0);
    expect(showText.stdout).toContain('Envelope:');
    expect(showText.stdout).toContain('Task: issue_verify (step 3, attempt 1)');
    expect(showText.stdout).toContain('Provider: skill -> pc-issue-verify');

    const showJson = runEnvelopeCli(['show', envelopePath, '--json']);
    expect(showJson.status).toBe(0);
    const parsed = JSON.parse(showJson.stdout);
    expect(parsed.task.logical_stage).toBe('issue_verify');
  });

  it('F1.4: show subcommand retrieves nested fields with --field', () => {
    const envelopePath = path.join(testEnv.dir, 'field-envelope.json');
    const receiptPath = path.join(testEnv.dir, 'field-receipt.md');

    runEnvelopeCli([
      'create',
      '--output', envelopePath,
      '--stage', 'pipeline_refactor',
      '--step', '4',
      '--root-issue', '99',
      '--provider-type', 'script',
      '--provider-target', 'scripts/refactor.py',
      '--provider-arg=--dry-run',
      '--workdir', testEnv.dir,
      '--objective', 'Refactor snakemake rules',
      '--receipt-path', receiptPath,
    ]);

    const stageField = runEnvelopeCli([
      'show', envelopePath,
      '--field', 'task.logical_stage',
    ]);
    expect(stageField.status).toBe(0);
    expect(stageField.stdout.trim()).toBe('pipeline_refactor');

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
    const envelopePath = path.join(testEnv.dir, 'budget-envelope.json');
    const receiptPath = path.join(testEnv.dir, 'receipt.md');

    const result = runEnvelopeCli([
      'create',
      '--output', envelopePath,
      '--stage', 'issue_work',
      '--step', '2',
      '--root-issue', '200',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-work',
      '--workdir', testEnv.dir,
      '--objective', 'Implement feature X',
      '--receipt-path', receiptPath,
      '--delivery-attempts-max', '5',
      '--replans-max', '3',
    ]);

    expect(result.status).toBe(0);
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.budgets.delivery_attempts_used).toBe(0);
    expect(env.budgets.delivery_attempts_max).toBe(5);
    expect(env.budgets.delivery_attempts_limit).toBe(5);
    expect(env.budgets.replans_used).toBe(0);
    expect(env.budgets.replans_max).toBe(3);
    expect(env.budgets.replans_limit).toBe(3);
  });

  it('F1.6: populates context and predecessor receipts from state.json via --from-state', () => {
    const stateFile = path.join(testEnv.dir, 'state.json');
    const predecessorReceipt = path.join(testEnv.dir, 'plan-receipt.md');
    fs.writeFileSync(predecessorReceipt, '# Plan Receipt\nStatus: completed');

    const stateData = {
      root_issue_id: '300',
      current_issue_id: '301',
      workflow: 'default',
      current_stage: 'issue_work',
      stage_status: 'pending',
      completed_stages: [
        {
          stage: 'stage_1_plan',
          status: 'succeeded',
          receipt_path: predecessorReceipt,
        },
      ],
      budgets: {
        delivery_attempts_used: 1,
        replans_used: 0,
      },
      context: {
        worktree: testEnv.dir,
        base_branch: 'main',
        branch: 'issue-301',
        commit: '1234567890123456789012345678901234567890',
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(stateData, null, 2));

    const envelopePath = path.join(testEnv.dir, 'state-envelope.json');
    const receiptPath = path.join(testEnv.dir, 'work-receipt.md');

    const result = runEnvelopeCli([
      'create',
      '--from-state', stateFile,
      '--output', envelopePath,
      '--step', '2',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-work',
      '--objective', 'Implement child issue 301',
      '--receipt-path', receiptPath,
    ]);

    expect(result.status).toBe(0);
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.task.logical_stage).toBe('issue_work');
    expect(env.task.root_issue_id).toBe('300');
    expect(env.task.current_issue_id).toBe('301');
    expect(env.environment.working_directory).toBe(path.resolve(testEnv.dir));
    expect(env.environment.branch).toBe('issue-301');
    expect(env.environment.commit).toBe('1234567890123456789012345678901234567890');
    expect(env.inputs.predecessor_receipts).toContain(predecessorReceipt);
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
    const envelopePath = path.join(testEnv.dir, 'skill-env.json');
    const result = runEnvelopeCli([
      'create',
      '--output', envelopePath,
      '--stage', 'workspace_prepare',
      '--step', '1',
      '--root-issue', '50',
      '--provider-type', 'skill',
      '--provider-target', 'pc-workspace',
      '--workdir', testEnv.dir,
      '--objective', 'Prepare workspace via skill',
      '--receipt-path', path.join(testEnv.dir, 'receipt.md'),
    ]);

    expect(result.status).toBe(0);
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.provider.type).toBe('skill');
    expect(env.provider.target).toBe('pc-workspace');
    expect(env.provider.args).toEqual([]);
  });

  it('F2.2: configures provider type "script" targeting executable script', () => {
    const envelopePath = path.join(testEnv.dir, 'script-env.json');
    const result = runEnvelopeCli([
      'create',
      '--output', envelopePath,
      '--stage', 'workspace_prepare',
      '--step', '1',
      '--root-issue', '50',
      '--provider-type', 'script',
      '--provider-target', 'skills/pc-workspace/scripts/prepare-worktree.py',
      '--provider-arg=--issue',
      '--provider-arg=50',
      '--workdir', testEnv.dir,
      '--objective', 'Prepare workspace via script kernel',
      '--receipt-path', path.join(testEnv.dir, 'receipt.md'),
    ]);

    expect(result.status).toBe(0);
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.provider.type).toBe('script');
    expect(env.provider.target).toBe('skills/pc-workspace/scripts/prepare-worktree.py');
    expect(env.provider.args).toEqual(['--issue', '50']);
  });

  it('F2.3: rejects unsupported provider types with schema validation error', () => {
    const envelopePath = path.join(testEnv.dir, 'invalid-provider.json');
    const result = runEnvelopeCli([
      'create',
      '--output', envelopePath,
      '--stage', 'issue_work',
      '--step', '2',
      '--root-issue', '60',
      '--provider-type', 'plugin', // Invalid: only 'skill' | 'script' allowed
      '--provider-target', 'custom-plugin',
      '--workdir', testEnv.dir,
      '--objective', 'Test invalid provider',
      '--receipt-path', path.join(testEnv.dir, 'receipt.md'),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[provider.type] Expected 'skill' | 'script'");
  });

  it('F2.4: preserves multiple ordered provider arguments', () => {
    const envelopePath = path.join(testEnv.dir, 'args-env.json');
    const result = runEnvelopeCli([
      'create',
      '--output', envelopePath,
      '--stage', 'issue_verify',
      '--step', '3',
      '--root-issue', '70',
      '--provider-type', 'script',
      '--provider-target', 'scripts/verify.py',
      '--provider-arg=--suite=e2e',
      '--provider-arg=--timeout=60',
      '--provider-arg=--strict',
      '--workdir', testEnv.dir,
      '--objective', 'Run verification script',
      '--receipt-path', path.join(testEnv.dir, 'receipt.md'),
    ]);

    expect(result.status).toBe(0);
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.provider.args).toEqual(['--suite=e2e', '--timeout=60', '--strict']);
  });

  it('F2.5: stage definition schema remains identical across provider types', () => {
    const skillEnvPath = path.join(testEnv.dir, 'stage-skill.json');
    const scriptEnvPath = path.join(testEnv.dir, 'stage-script.json');

    runEnvelopeCli([
      'create',
      '--output', skillEnvPath,
      '--stage', 'issue_plan',
      '--step', '1',
      '--root-issue', '80',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-plan',
      '--workdir', testEnv.dir,
      '--objective', 'Planning stage with skill',
      '--receipt-path', path.join(testEnv.dir, 'receipt-1.md'),
    ]);

    runEnvelopeCli([
      'create',
      '--output', scriptEnvPath,
      '--stage', 'issue_plan',
      '--step', '1',
      '--root-issue', '80',
      '--provider-type', 'script',
      '--provider-target', 'scripts/automated_plan.py',
      '--workdir', testEnv.dir,
      '--objective', 'Planning stage with script',
      '--receipt-path', path.join(testEnv.dir, 'receipt-2.md'),
    ]);

    const skillEnv: TaskInputEnvelope = JSON.parse(fs.readFileSync(skillEnvPath, 'utf-8'));
    const scriptEnv: TaskInputEnvelope = JSON.parse(fs.readFileSync(scriptEnvPath, 'utf-8'));

    // The task structure, environment structure, contract structure and schema version are invariant
    expect(skillEnv.schema_version).toBe(scriptEnv.schema_version);
    expect(skillEnv.task.logical_stage).toBe(scriptEnv.task.logical_stage);
    expect(skillEnv.task.step_index).toBe(scriptEnv.task.step_index);
    expect(skillEnv.contract.receipt_template).toBe(scriptEnv.contract.receipt_template);
    expect(Object.keys(skillEnv)).toEqual(Object.keys(scriptEnv));
  });
});
