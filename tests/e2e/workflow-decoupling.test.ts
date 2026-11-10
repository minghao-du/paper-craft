/**
 * Workflow Stage-Provider Decoupling & Schema Verification Tests
 *
 * Verifies that:
 * 1. skills/pc-orchestrator/workflows/default.md contains decoupled logical stages and providers.
 * 2. Every stage's provider is either "skill" or "script", targeting existing codebase assets.
 * 3. Every stage definition successfully maps to a valid Task Input Envelope.
 * 4. Substituting an execution provider from skill to script preserves state machine invariance (zero-perception).
 * 5. Corrupted provider definitions are reliably rejected by envelope schema validation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  createTestDir,
  PREPARE_WORKTREE_SCRIPT,
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
  providerType: 'skill' | 'script';
  providerTarget: string;
  providerArgs: string[];
}

/**
 * Stage definition in declarative YAML workflow manifest.
 */
export interface WorkflowManifestStage {
  id: string;
  logical_task: string;
  name?: string;
  provider: {
    type: 'skill' | 'script' | string;
    target: string;
    args?: string[];
  };
}

/**
 * Top-level declarative YAML workflow manifest.
 */
export interface WorkflowManifest {
  workflow: {
    name: string;
    version: string;
    initial_stage: string;
    target?: string;
    stages: WorkflowManifestStage[];
  };
}

/**
 * Extract declarative YAML manifest block from markdown content.
 */
export function extractYamlManifest(content: string): string {
  const match = content.match(/```yaml\s*\r?\n([\s\S]*?)\r?\n```/);
  if (!match) {
    throw new Error('No ```yaml manifest block found in workflow file');
  }
  return match[1];
}

/**
 * Strict validator for declarative workflow manifest.
 */
export function parseAndValidateYamlManifest(content: string): WorkflowManifest {
  const yamlBlock = extractYamlManifest(content);
  const parsed = parseYaml(yamlBlock);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Manifest root must be an object containing a workflow block');
  }

  const workflow = (parsed as Record<string, unknown>).workflow;
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new Error("Missing required top-level object: 'workflow'");
  }

  const wf = workflow as Record<string, unknown>;

  if (!wf.name || typeof wf.name !== 'string' || !wf.name.trim()) {
    throw new Error("Missing required field 'workflow.name'");
  }

  if (!wf.version || typeof wf.version !== 'string' || !wf.version.trim()) {
    throw new Error("Missing required field 'workflow.version'");
  }

  if (!wf.initial_stage || typeof wf.initial_stage !== 'string' || !wf.initial_stage.trim()) {
    throw new Error("Missing required field 'workflow.initial_stage'");
  }

  if (!Array.isArray(wf.stages) || wf.stages.length === 0) {
    throw new Error("Field 'workflow.stages' must be a non-empty array");
  }

  for (let i = 0; i < wf.stages.length; i++) {
    const stage = wf.stages[i];
    const prefix = `workflow.stages[${i}]`;

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
    if (pType !== 'skill' && pType !== 'script') {
      throw new Error(`${prefix}.provider.type must be 'skill' or 'script', got '${String(pType)}'`);
    }

    const pTarget = p.target;
    if (!pTarget || typeof pTarget !== 'string' || !pTarget.trim()) {
      throw new Error(`${prefix}.provider.target must be a non-empty string`);
    }

    if (p.args !== undefined && !Array.isArray(p.args)) {
      throw new Error(`${prefix}.provider.args must be an array of strings if provided`);
    }
  }

  return parsed as WorkflowManifest;
}

/**
 * Helper to parse stage definitions and provider blocks from markdown content.
 */
export function parseWorkflowStagesFromContent(content: string): ParsedWorkflowStage[] {
  const lines = content.split('\n');
  const stages: ParsedWorkflowStage[] = [];

  let currentStageId = '';
  let currentLogicalTask = '';
  let currentProviderType: string | null = null;
  let currentProviderTarget = '';
  let currentProviderArgs: string[] = [];
  let inProviderBlock = false;
  let headersCount = 0;

  const finalizeStage = () => {
    if (!currentStageId) return;
    if (!currentProviderType) {
      throw new Error(`Stage "${currentStageId}" in markdown is missing a provider definition or provider.type`);
    }
    if (currentProviderType !== 'skill' && currentProviderType !== 'script') {
      throw new Error(
        `Stage "${currentStageId}" has unsupported provider type "${currentProviderType}". Expected 'skill' | 'script'.`,
      );
    }
    if (!currentProviderTarget) {
      throw new Error(`Stage "${currentStageId}" has empty provider target.`);
    }
    stages.push({
      id: currentStageId,
      logicalTask: currentLogicalTask,
      providerType: currentProviderType as 'skill' | 'script',
      providerTarget: currentProviderTarget,
      providerArgs: currentProviderArgs,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect Stage Header, e.g. "## Stage 1 — Planning and Decomposition (`stage_1_plan`)"
    const headerMatch = line.match(/^#{2,3}\s+(?:(?:Auxiliary\s+)?Stage|Step)\s+.*?\(`?([a-zA-Z0-9_]+)`?\)/i);
    if (headerMatch) {
      finalizeStage();
      headersCount++;
      currentStageId = headerMatch[1];
      currentLogicalTask = headerMatch[1]; // default to header id
      currentProviderType = null;
      currentProviderTarget = '';
      currentProviderArgs = [];
      inProviderBlock = false;
      continue;
    }

    // Detect Logical Stage / Logical Task
    const taskMatch = line.match(/^\s*-\s*\*\*(?:Logical Stage|Logical Task)\*\*:\s*`?([a-zA-Z0-9_]+)`?/i);
    if (taskMatch) {
      currentLogicalTask = taskMatch[1];
    }

    // Detect Provider block
    if (line.match(/^\s*-\s*\*\*(?:Default\s+)?Provider\*\*:/i) || line.match(/^\s*provider:\s*$/i)) {
      inProviderBlock = true;
      continue;
    }

    if (inProviderBlock) {
      const typeMatch =
        line.match(/^\s*-\s*`?type`?:\s*["']?([^"'\s]+)["']?/i) ||
        line.match(/^\s*type:\s*["']?([^"'\s]+)["']?/i);
      if (typeMatch) {
        currentProviderType = typeMatch[1];
      }

      const targetMatch =
        line.match(/^\s*-\s*`?target`?:\s*["']?([^"'\s]+)["']?/i) ||
        line.match(/^\s*target:\s*["']?([^"'\s]+)["']?/i);
      if (targetMatch) {
        currentProviderTarget = targetMatch[1];
      }

      const argsMatch = line.match(/^\s*args:\s*\[(.*?)\]/i);
      if (argsMatch) {
        currentProviderArgs = argsMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      }

      // Exit provider block on unindented list item or new header or code block end
      if (
        line.match(/^\s*```/) ||
        line.match(/^#{2,3}\s+/) ||
        (line.match(/^\s*-\s*\*\*[A-Z]/) && !line.includes('Provider'))
      ) {
        inProviderBlock = false;
      }
    }
  }

  finalizeStage();

  if (headersCount !== stages.length) {
    throw new Error(`Mismatch between stage headers (${headersCount}) and parsed stages (${stages.length})`);
  }

  return stages;
}

/**
 * Helper to parse stage definitions and provider blocks from default.md.
 */
export function parseWorkflowStages(workflowPath: string): ParsedWorkflowStage[] {
  const content = fs.readFileSync(workflowPath, 'utf-8');
  return parseWorkflowStagesFromContent(content);
}

describe('Milestone M3: Workflow Stage-Provider Decoupling Suite', () => {
  let testEnv: { dir: string; cleanup: () => void };
  const defaultWorkflowPath = path.join(
    REPO_ROOT,
    'skills/pc-orchestrator/workflows/default.md',
  );

  beforeEach(() => {
    testEnv = createTestDir('workflow-decoupling-');
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('W1.1: default.md exists and contains decoupled stage definitions', () => {
    expect(fs.existsSync(defaultWorkflowPath)).toBe(true);
    const content = fs.readFileSync(defaultWorkflowPath, 'utf-8');

    // Asserts decoupled provider syntax exists in default.md
    expect(content).toMatch(/provider:/i);
    expect(content).toMatch(/type:\s*["']?(skill|script)["']?/i);
    expect(content).toMatch(new RegExp('target:\\s*["\']?[a-zA-Z0-9_./-]+["\']?', 'i'));
  });

  it('W1.2: validates declarative YAML manifest and detailed markdown stages with 1:1 parity and existing targets', () => {
    const content = fs.readFileSync(defaultWorkflowPath, 'utf-8');
    const manifest = parseAndValidateYamlManifest(content);
    const markdownStages = parseWorkflowStages(defaultWorkflowPath);

    expect(manifest.workflow.name).toBe('default');
    expect(manifest.workflow.version).toBe('1.0.0');
    expect(manifest.workflow.initial_stage).toBe('stage_1_plan');
    expect(manifest.workflow.stages.length).toBe(12);
    expect(markdownStages.length).toBe(12);

    // Verify 1:1 parity between declarative manifest and detailed markdown sections
    for (let i = 0; i < manifest.workflow.stages.length; i++) {
      const mStage = manifest.workflow.stages[i];
      const mdStage = markdownStages[i];

      expect(mStage.id).toBe(mdStage.id);
      expect(mStage.logical_task).toBe(mdStage.logicalTask);
      expect(mStage.provider.type).toBe(mdStage.providerType);
      expect(mStage.provider.target).toBe(mdStage.providerTarget);
      expect(mStage.provider.args ?? []).toEqual(mdStage.providerArgs);
    }

    // Verify all provider targets exist on disk
    for (const stage of markdownStages) {
      expect(['skill', 'script']).toContain(stage.providerType);
      expect(stage.providerTarget.length).toBeGreaterThan(0);

      if (stage.providerType === 'skill') {
        const skillSkillMd = path.join(REPO_ROOT, 'skills', stage.providerTarget, 'SKILL.md');
        expect(
          fs.existsSync(skillSkillMd),
          `Target skill ${stage.providerTarget} must exist at ${skillSkillMd}`,
        ).toBe(true);
      } else if (stage.providerType === 'script') {
        const scriptFile = path.resolve(REPO_ROOT, stage.providerTarget);
        expect(
          fs.existsSync(scriptFile),
          `Target script ${stage.providerTarget} must exist at ${scriptFile}`,
        ).toBe(true);
      }
    }
  });

  it('W1.3: each parsed stage generates a compliant Task Input Envelope passing validate', () => {
    const stages = parseWorkflowStages(defaultWorkflowPath);
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
        stage: stage.logicalTask,
        objective: `Execute stage ${stage.logicalTask}`,
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
  }, 20000);

  it('W1.4: zero-perception provider substitution preserves state machine and contract invariance', () => {
    // Stage: workspace_prepare
    // Variant A: skill provider (pc-workspace)
    const rootSkill = path.join(testEnv.dir, 'skill-run');
    runLifecycleKernelCli(['init', '--receipt-root', rootSkill, '--root-issue', '200']);
    const prepSkill = runPrepareTaskCli(rootSkill, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace via skill',
      provider: {
        type: 'skill',
        target: 'pc-workspace',
      },
      workdir: testEnv.dir,
    });
    const envSkillPath = JSON.parse(prepSkill.stdout).envelope_path;

    // Variant B: script provider (prepare-worktree.py)
    const rootScript = path.join(testEnv.dir, 'script-run');
    runLifecycleKernelCli(['init', '--receipt-root', rootScript, '--root-issue', '200']);
    const prepScript = runPrepareTaskCli(rootScript, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace via script kernel',
      provider: {
        type: 'script',
        target: 'skills/pc-workspace/scripts/prepare-worktree.py',
      },
      workdir: testEnv.dir,
    });
    const envScriptPath = JSON.parse(prepScript.stdout).envelope_path;

    const envSkill: TaskInputEnvelope = JSON.parse(fs.readFileSync(envSkillPath, 'utf-8'));
    const envScript: TaskInputEnvelope = JSON.parse(fs.readFileSync(envScriptPath, 'utf-8'));

    // Structural invariance
    expect(envSkill.schema_version).toBe(envScript.schema_version);
    expect(envSkill.task.logical_stage).toBe(envScript.task.logical_stage);
    expect(envSkill.task.step_index).toBe(envScript.task.step_index);
    expect(envSkill.environment.working_directory).toBe(envScript.environment.working_directory);
    expect(envSkill.contract.receipt_template).toBe(envScript.contract.receipt_template);

    // Kernel zero-perception verification
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '200',
    ]);
    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace for issue 200',
      provider: {
        type: 'script',
        target: PREPARE_WORKTREE_SCRIPT,
      },
    });
    const prepData = JSON.parse(prepRes.stdout);
    runLifecycleKernelCli([
      'handoff',
      '--receipt-root', testEnv.dir,
    ]);

    fs.writeFileSync(prepData.receipt_path, '# Script Receipt\nOutcome: prepared');
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
  }, 15000);

  it('W1.5: rejects malformed provider definitions with schema validation error', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '300',
    ]);
    const res = runPrepareTaskCli(testEnv.dir, {
      stage: 'issue_work',
      objective: 'Test bad provider type',
      provider: {
        type: 'unsupported_provider',
        target: 'dummy-target',
      },
      workdir: testEnv.dir,
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Provider 'type' must be 'skill' or 'script'");
  });

  it('W1.6: parseWorkflowStages actively rejects malformed stages instead of silently dropping', () => {
    const badTypeMd = [
      '### Stage 1 — Planning (`stage_1_plan`)',
      '- **Logical Task**: `issue_plan`',
      '- **Default Provider**:',
      '  - `type`: "remote"',
      '  - `target`: "http://api.remote/plan"',
    ].join('\n');

    expect(() => parseWorkflowStagesFromContent(badTypeMd)).toThrow(
      /unsupported provider type "remote"/i,
    );

    const missingProviderMd = [
      '### Stage 1 — Planning (`stage_1_plan`)',
      '- **Logical Task**: `issue_plan`',
    ].join('\n');

    expect(() => parseWorkflowStagesFromContent(missingProviderMd)).toThrow(
      /missing a provider definition/i,
    );

    const missingTargetMd = [
      '### Stage 1 — Planning (`stage_1_plan`)',
      '- **Logical Task**: `issue_plan`',
      '- **Default Provider**:',
      '  - `type`: "skill"',
      '  - `target`: ""',
    ].join('\n');

    expect(() => parseWorkflowStagesFromContent(missingTargetMd)).toThrow(
      /empty provider target/i,
    );
  });

  it('W1.7: YAML manifest parsing actively rejects malformed manifests', () => {
    const syntaxErrorMd = '```yaml\nworkflow:\n  name: [unclosed\n```';
    expect(() => parseAndValidateYamlManifest(syntaxErrorMd)).toThrow();

    const missingNameMd = '```yaml\nworkflow:\n  version: 1.0.0\n  initial_stage: s1\n  stages: []\n```';
    expect(() => parseAndValidateYamlManifest(missingNameMd)).toThrow(/Missing required field 'workflow\.name'/i);

    const emptyStagesMd = '```yaml\nworkflow:\n  name: default\n  version: 1.0.0\n  initial_stage: s1\n  stages: []\n```';
    expect(() => parseAndValidateYamlManifest(emptyStagesMd)).toThrow(/Field 'workflow\.stages' must be a non-empty array/i);

    const badTypeMd =
      '```yaml\nworkflow:\n  name: default\n  version: 1.0.0\n  initial_stage: s1\n  stages:\n    - id: s1\n      logical_task: t1\n      provider:\n        type: remote\n        target: pc-workspace\n```';
    expect(() => parseAndValidateYamlManifest(badTypeMd)).toThrow(/provider\.type must be 'skill' or 'script'/i);
  });
});
