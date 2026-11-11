/**
 * Workflow Stage-Provider Decoupling & Schema Verification Tests
 *
 * Verifies that:
 * 1. skills/pc-orchestrator/workflows/default.json contains decoupled logical stages and providers.
 * 2. Every stage's provider is strictly "skill", targeting existing codebase skills.
 * 3. Every stage definition successfully maps to a valid Task Input Envelope.
 * 4. Substituting an execution provider target preserves state machine invariance (zero-perception).
 * 5. Corrupted provider definitions and deprecated "script" providers are reliably rejected by envelope schema validation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDir,
  REPO_ROOT,
  runEnvelopeCli,
  runLifecycleKernelCli,
  runPrepareTaskCli,
  type TaskInputEnvelope,
} from './test-helpers.js';

/**
 * Parsed stage representation from workflow file.
 */
export interface ParsedWorkflowStage {
  id: string;
  logicalTask: string;
  providerType: 'skill';
  providerTarget: string;
  providerArgs: string[];
}

/**
 * Stage definition in declarative JSON workflow manifest.
 */
export interface WorkflowManifestStage {
  id: string;
  logical_task: string;
  name?: string;
  provider: {
    type: string;
    target: string;
    args?: string[];
  };
}

/**
 * Top-level declarative JSON workflow manifest.
 */
export interface WorkflowManifest {
  name: string;
  version: string;
  initial_stage: string;
  target?: string;
  description?: string;
  stages: WorkflowManifestStage[];
}

/**
 * Strict validator for declarative workflow manifest JSON content.
 */
export function parseAndValidateJsonManifest(content: string): WorkflowManifest {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Manifest root must be an object');
  }

  const raw = (parsed as Record<string, unknown>).workflow ?? parsed;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Missing required workflow object');
  }

  const wf = raw as Record<string, unknown>;

  if (!wf.name || typeof wf.name !== 'string' || !wf.name.trim()) {
    throw new Error("Missing required field 'name'");
  }

  if (!wf.version || typeof wf.version !== 'string' || !wf.version.trim()) {
    throw new Error("Missing required field 'version'");
  }

  if (!wf.initial_stage || typeof wf.initial_stage !== 'string' || !wf.initial_stage.trim()) {
    throw new Error("Missing required field 'initial_stage'");
  }

  if (!Array.isArray(wf.stages) || wf.stages.length === 0) {
    throw new Error("Field 'stages' must be a non-empty array");
  }

  const stages: WorkflowManifestStage[] = [];
  for (let i = 0; i < wf.stages.length; i++) {
    const stage = wf.stages[i];
    const prefix = `stages[${i}]`;

    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new Error(`${prefix} must be an object`);
    }

    const s = stage as Record<string, unknown>;

    if (!s.id || typeof s.id !== 'string' || !s.id.trim()) {
      throw new Error(`${prefix} missing required string 'id'`);
    }

    if (!s.logical_task || typeof s.logical_task !== 'string' || !s.logical_task.trim()) {
      throw new Error(`${prefix} missing required string 'logical_task'`);
    }

    if (!s.provider || typeof s.provider !== 'object' || Array.isArray(s.provider)) {
      throw new Error(`${prefix} missing required object 'provider'`);
    }

    const p = s.provider as Record<string, unknown>;
    const pType = p.type;
    if (pType !== 'skill') {
      throw new Error(`${prefix}.provider.type must be 'skill', got '${String(pType)}'`);
    }

    const pTarget = p.target;
    if (!pTarget || typeof pTarget !== 'string' || !pTarget.trim()) {
      throw new Error(`${prefix}.provider.target must be a non-empty string`);
    }

    if (p.args !== undefined && !Array.isArray(p.args)) {
      throw new Error(`${prefix}.provider.args must be an array of strings if provided`);
    }

    stages.push({
      id: s.id as string,
      logical_task: s.logical_task as string,
      name: s.name as string | undefined,
      provider: {
        type: p.type as string,
        target: p.target as string,
        args: (p.args as string[]) ?? [],
      },
    });
  }

  return {
    name: wf.name as string,
    version: wf.version as string,
    initial_stage: wf.initial_stage as string,
    target: wf.target as string | undefined,
    description: wf.description as string | undefined,
    stages,
  };
}

/**
 * Helper to parse stage definitions and provider blocks from default.json.
 */
export function parseWorkflowStages(workflowPath: string): ParsedWorkflowStage[] {
  const content = fs.readFileSync(workflowPath, 'utf-8');
  const manifest = parseAndValidateJsonManifest(content);
  return manifest.stages.map((s) => ({
    id: s.id,
    logicalTask: s.logical_task,
    providerType: 'skill',
    providerTarget: s.provider.target,
    providerArgs: s.provider.args ?? [],
  }));
}

describe('Milestone M3: Workflow Stage-Provider Decoupling Suite', () => {
  let testEnv: { dir: string; cleanup: () => void };
  const defaultWorkflowJsonPath = path.join(
    REPO_ROOT,
    'skills/pc-orchestrator/workflows/default.json',
  );
  const defaultWorkflowDocPath = path.join(
    REPO_ROOT,
    'skills/pc-orchestrator/workflows/default.md',
  );

  beforeEach(() => {
    testEnv = createTestDir('workflow-decoupling-');
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('W1.1: default.json exists and default.md references it without duplicating flow definition', () => {
    expect(fs.existsSync(defaultWorkflowJsonPath)).toBe(true);
    const jsonContent = fs.readFileSync(defaultWorkflowJsonPath, 'utf-8');

    // Asserts decoupled provider syntax exists in default.json
    expect(jsonContent).toMatch(/"provider"\s*:/i);
    expect(jsonContent).toMatch(/"type"\s*:\s*"skill"/i);
    expect(jsonContent).toMatch(/"target"\s*:\s*"[a-zA-Z0-9_.-]+"/i);

    // Asserts default.md references default.json and does not duplicate full JSON flow block
    expect(fs.existsSync(defaultWorkflowDocPath)).toBe(true);
    const docContent = fs.readFileSync(defaultWorkflowDocPath, 'utf-8');
    expect(docContent).toContain('default.json');
    expect(docContent).not.toMatch(/```json[\s\S]*?stages:\s*[\s\S]*?```/);
  });

  it('W1.2: validates declarative JSON manifest stages and ensures all provider targets exist', () => {
    const content = fs.readFileSync(defaultWorkflowJsonPath, 'utf-8');
    const manifest = parseAndValidateJsonManifest(content);
    const stages = parseWorkflowStages(defaultWorkflowJsonPath);

    expect(manifest.name).toBe('default');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.initial_stage).toBe('stage_1_plan');
    expect(manifest.stages.length).toBeGreaterThanOrEqual(12);
    expect(stages.length).toBe(manifest.stages.length);

    // Verify all provider targets are skills and exist on disk
    for (const stage of stages) {
      expect(stage.providerType).toBe('skill');
      expect(stage.providerTarget.length).toBeGreaterThan(0);

      const skillSkillMd = path.join(REPO_ROOT, 'skills', stage.providerTarget, 'SKILL.md');
      expect(
        fs.existsSync(skillSkillMd),
        `Target skill ${stage.providerTarget} must exist at ${skillSkillMd}`,
      ).toBe(true);
    }
  });

  it('W1.3: each parsed stage generates a compliant Task Input Envelope passing validate', () => {
    const stages = parseWorkflowStages(defaultWorkflowJsonPath);
    expect(stages.length).toBeGreaterThan(0);

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const stageRoot = path.join(testEnv.dir, `stage-${i}`);
      runLifecycleKernelCli([
        'init',
        '--receipt-root', stageRoot,
        '--root-issue', '100',
      ]);

      const res = runPrepareTaskCli(stageRoot, {
        stage: stage.id,
        objective: `Execute stage ${stage.id}`,
        provider: {
          type: stage.providerType,
          target: stage.providerTarget,
          args: stage.providerArgs,
        },
        workdir: testEnv.dir,
      });

      expect(res.status).toBe(0);
      const prepData = JSON.parse(res.stdout);
      expect(fs.existsSync(prepData.envelope_path)).toBe(true);

      const valRes = runEnvelopeCli(['validate', prepData.envelope_path]);
      expect(valRes.status).toBe(0);
      expect(valRes.stdout).toContain('Valid envelope');
    }
  }, 60000);

  it('W1.4: provider target substitution preserves state machine and contract invariance', () => {
    // Stage: workspace_prepare
    // Target A: pc-workspace
    const rootSkillA = path.join(testEnv.dir, 'skill-run-a');
    runLifecycleKernelCli(['init', '--receipt-root', rootSkillA, '--root-issue', '200']);
    const prepSkillA = runPrepareTaskCli(rootSkillA, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace via pc-workspace',
      provider: {
        type: 'skill',
        target: 'pc-workspace',
      },
      workdir: testEnv.dir,
    });
    const envSkillAPath = JSON.parse(prepSkillA.stdout).envelope_path;

    // Target B: pc-issue-plan
    const rootSkillB = path.join(testEnv.dir, 'skill-run-b');
    runLifecycleKernelCli(['init', '--receipt-root', rootSkillB, '--root-issue', '200']);
    const prepSkillB = runPrepareTaskCli(rootSkillB, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace via pc-issue-plan target',
      provider: {
        type: 'skill',
        target: 'pc-issue-plan',
      },
      workdir: testEnv.dir,
    });
    const envSkillBPath = JSON.parse(prepSkillB.stdout).envelope_path;

    const envA: TaskInputEnvelope = JSON.parse(fs.readFileSync(envSkillAPath, 'utf-8'));
    const envB: TaskInputEnvelope = JSON.parse(fs.readFileSync(envSkillBPath, 'utf-8'));

    // Structural invariance
    expect(envA.schema_version).toBe(envB.schema_version);
    expect(envA.task.logical_stage).toBe(envB.task.logical_stage);
    expect(envA.task.step_index).toBe(envB.task.step_index);
    expect(envA.environment.working_directory).toBe(envB.environment.working_directory);
    expect(envA.contract.receipt_template).toBe(envB.contract.receipt_template);

    // Lifecycle kernel execution verification
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '200',
    ]);
    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace for issue 200',
      provider: {
        type: 'skill',
        target: 'pc-workspace',
      },
      workdir: testEnv.dir,
    });
    const prepData = JSON.parse(prepRes.stdout);
    runLifecycleKernelCli([
      'handoff',
      '--receipt-root', testEnv.dir,
    ]);

    fs.writeFileSync(prepData.receipt_path, '# Receipt\nOutcome: prepared');
    const compRes = runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--report', JSON.stringify({
        execution_status: 'succeeded',
        result: { outcome: 'prepared' },
        receipt_path: prepData.receipt_path,
        summary: 'Workspace prepared',
      }),
    ]);
    expect(compRes.status).toBe(0);

    const stateShow = runLifecycleKernelCli(['inspect', '--receipt-root', testEnv.dir, '--json']);
    const stateObj = JSON.parse(stateShow.stdout);
    expect(stateObj.completed_stages_count).toBe(1);
  }, 20000);

  it('W1.5: rejects malformed provider definitions with schema validation error', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '300',
    ]);
    const res = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_work',
      objective: 'Test bad provider type',
      provider: {
        type: 'unsupported_provider',
        target: 'dummy-target',
      },
      workdir: testEnv.dir,
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Provider 'type' must be 'skill'");

    // Specifically verify deprecated 'script' provider is rejected
    const resScript = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_work',
      objective: 'Test script provider rejection',
      provider: {
        type: 'script',
        target: 'scripts/worker.py',
      },
      workdir: testEnv.dir,
    });

    expect(resScript.status).not.toBe(0);
    expect(resScript.stderr).toContain("Provider 'type' must be 'skill'");
  });

  it('W1.6: JSON manifest parsing actively rejects malformed manifests', () => {
    const syntaxErrorJson = '{"name": [unclosed';
    expect(() => parseAndValidateJsonManifest(syntaxErrorJson)).toThrow();

    const missingNameJson = JSON.stringify({ version: '1.0.0', initial_stage: 's1', stages: [] });
    expect(() => parseAndValidateJsonManifest(missingNameJson)).toThrow(/Missing required field 'name'/i);

    const emptyStagesJson = JSON.stringify({ name: 'default', version: '1.0.0', initial_stage: 's1', stages: [] });
    expect(() => parseAndValidateJsonManifest(emptyStagesJson)).toThrow(/Field 'stages' must be a non-empty array/i);

    const badTypeJson =
      JSON.stringify({ name: 'default', version: '1.0.0', initial_stage: 's1', stages: [{ id: 's1', logical_task: 't1', provider: { type: 'script', target: 'pc-workspace' } }] });
    expect(() => parseAndValidateJsonManifest(badTypeJson)).toThrow(/provider\.type must be 'skill'/i);
  });
});
