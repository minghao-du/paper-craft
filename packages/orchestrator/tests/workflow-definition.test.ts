/**
 * Workflow Stage-Provider Decoupling & Schema Verification Tests (W1.1-W1.6 + Refactor Invariants).
 *
 * Verifies that:
 * 1. skills/pc-orchestrator/workflows/default.json contains decoupled logical stages and providers.
 * 2. Every stage's provider is strictly "skill", targeting existing codebase skills.
 * 3. Every stage definition successfully maps to a valid Task Input Envelope.
 * 4. Substituting an execution provider target preserves state machine invariance (zero-perception).
 * 5. Corrupted provider definitions and deprecated "script" providers are reliably rejected.
 * 6. loadAndValidateWorkflow enforces strict domain rules (W01, W02, W03, snapshot mode).
 * 7. evaluateDispatch enforces provider override limits for evidence-sensitive stages and scope/template contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RECEIPT_TEMPLATE,
  evaluateDispatch,
  loadAndValidateWorkflow,
  resolveCanonicalStage,
} from '../src/workflow/index.js';
import {
  allocatesDeliveryAttempt,
  invalidatesLanding,
  invalidatesVerification,
  isAuxiliaryStage,
  isCleanupStage,
  isContentChangingStage,
  isEvidenceSensitiveStage,
  isFinalizationStage,
  isInitialPlanStage,
  isLandingStage,
  isReplanStage,
  isResearchRecordStage,
  isVerificationStage,
} from '../src/workflow/stage.js';
import type { DeliveryState, WorkflowDefinition } from '../src/workflow/types.js';
import {
  createTestDir,
  REPO_ROOT,
  runEnvelopeCli,
  runLifecycleKernelCli,
  runDispatchTaskCli,
  type TaskInputEnvelope,
} from './helpers.js';

export interface ParsedWorkflowStage {
  id: string;
  logicalTask: string;
  providerType: 'skill';
  providerTarget: string;
  providerArgs: string[];
  replan?: boolean;
}

export function parseWorkflowStages(workflowPath: string): ParsedWorkflowStage[] {
  const manifest = loadAndValidateWorkflow(workflowPath);
  return manifest.stages.map((s) => ({
    id: s.id,
    logicalTask: s.logical_task!,
    providerType: 'skill',
    providerTarget: s.provider!.target,
    providerArgs: s.provider!.args ?? [],
    replan: Boolean(s.replan),
  }));
}

describe('Workflow Stage-Provider Decoupling & Definition (W1.1-W1.6)', () => {
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
    const manifest = loadAndValidateWorkflow(defaultWorkflowJsonPath);
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

      const res = runDispatchTaskCli(stageRoot, {
        stage: stage.id,
        objective: `Execute stage ${stage.id}`,
        parameters: stage.replan
          ? { originating_stage: 'stage_1_plan' }
          : undefined,
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
    const prepSkillA = runDispatchTaskCli(rootSkillA, {
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
    const prepSkillB = runDispatchTaskCli(rootSkillB, {
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
    const prepRes = runDispatchTaskCli(testEnv.dir, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace for issue 200',
      provider: {
        type: 'skill',
        target: 'pc-workspace',
      },
      workdir: testEnv.dir,
    });
    const prepData = JSON.parse(prepRes.stdout);
    fs.writeFileSync(prepData.receipt_path, '# Receipt\nOutcome: prepared');
    const compRes = runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--dispatch-id', prepData.dispatch_id,
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
    const res = runDispatchTaskCli(testEnv.dir, {
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
    const resScript = runDispatchTaskCli(testEnv.dir, {
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

  it('W1.6: loadAndValidateWorkflow actively rejects malformed manifests', () => {
    expect(() => loadAndValidateWorkflow('{"name": [unclosed')).toThrow();

    expect(() =>
      loadAndValidateWorkflow({
        version: '1.0.0',
        completion_policy: 'issue_delivery',
        initial_stage: 's1',
        stages: [],
      }),
    ).toThrow(/name/i);

    expect(() =>
      loadAndValidateWorkflow({
        name: 'default',
        version: '1.0.0',
        completion_policy: 'issue_delivery',
        initial_stage: 's1',
        stages: [],
      }),
    ).toThrow(/stages/i);

    expect(() =>
      loadAndValidateWorkflow({
        name: 'default',
        version: '1.0.0',
        completion_policy: 'issue_delivery',
        initial_stage: 's1',
        stages: [
          {
            id: 's1',
            logical_task: 't1',
            provider: { type: 'script', target: 'pc-workspace' },
          },
        ],
      }),
    ).toThrow(/provider.*'skill'/i);
  });
});

const baseWf: WorkflowDefinition = {
  name: 'test-wf',
  version: '1.0.0',
  completion_policy: 'issue_delivery',
  initial_stage: 's1',
  stages: [
    {
      id: 's1',
      logical_task: 'plan',
      provider: { type: 'skill', target: 'pc-issue-plan' },
    },
    {
      id: 's2',
      logical_task: 'work',
      provider: { type: 'skill', target: 'pc-issue-work' },
    },
    {
      id: 'plan',
      logical_task: 'alias_collision_target',
      provider: { type: 'skill', target: 'pc-issue-plan' },
    },
    {
      id: 'dupe_task_1',
      logical_task: 'shared_task',
      provider: { type: 'skill', target: 'pc-workspace' },
    },
    {
      id: 'dupe_task_2',
      logical_task: 'shared_task',
      provider: { type: 'skill', target: 'pc-workspace' },
    },
  ],
};

describe('Workflow Stage Resolution & Validation Domain Rules (W01, W02, W03)', () => {

  it('W01: exact id takes priority over logical_task collision', () => {
    // Stage id 'plan' collides with Stage s1's logical_task 'plan'.
    // Exact id 'plan' must win.
    const resolved = resolveCanonicalStage(baseWf, 'plan');
    expect(resolved.id).toBe('plan');
    expect(resolved.logical_task).toBe('alias_collision_target');

    // Looking up 's1' returns s1
    const resolvedS1 = resolveCanonicalStage(baseWf, 's1');
    expect(resolvedS1.id).toBe('s1');
    expect(resolvedS1.logical_task).toBe('plan');
  });

  it('W01: unambiguous logical_task alias resolves to canonical stage', () => {
    const resolved = resolveCanonicalStage(baseWf, 'work');
    expect(resolved.id).toBe('s2');
  });

  it('W01: ambiguous logical_task alias matching multiple stages is rejected with candidate ids', () => {
    expect(() => resolveCanonicalStage(baseWf, 'shared_task')).toThrowError(
      /Ambiguous stage reference 'shared_task': matches multiple stages \('dupe_task_1', 'dupe_task_2'\)/,
    );
  });

  it('W01: completely unknown stage reference throws and never invents a stage', () => {
    expect(() => resolveCanonicalStage(baseWf, 'non_existent_stage')).toThrowError(
      /Stage 'non_existent_stage' is not defined in workflow 'test-wf'/,
    );
  });

  it('W01: duplicate stage IDs are rejected at workflow load time', () => {
    expect(() =>
      loadAndValidateWorkflow({
        name: 'duplicate-test',
        completion_policy: 'issue_delivery',
        stages: [
          { id: 'same_id', logical_task: 't1', provider: { type: 'skill', target: 'p1' } },
          { id: 'same_id', logical_task: 't2', provider: { type: 'skill', target: 'p2' } },
        ],
      }),
    ).toThrowError(/Duplicate stage ID 'same_id'/);
  });

  it('W02: replan attribute is consistently determined from definition regardless of lookup method', () => {
    const replanWf = loadAndValidateWorkflow({
      name: 'replan-test',
      completion_policy: 'issue_delivery',
      stages: [
        {
          id: 'custom_replan_id',
          logical_task: 'scope_replan',
          replan: true,
          provider: { type: 'skill', target: 'pc-issue-plan' },
        },
        {
          id: 'scope_replan_name_only',
          logical_task: 'not_a_replan',
          replan: false,
          provider: { type: 'skill', target: 'pc-issue-plan' },
        },
      ],
    });

    const byId = resolveCanonicalStage(replanWf, 'custom_replan_id');
    const byAlias = resolveCanonicalStage(replanWf, 'scope_replan');
    expect(byId.replan).toBe(true);
    expect(byAlias.replan).toBe(true);
    expect(byId.id).toBe('custom_replan_id');

    // A stage that has id containing replan or name containing replan but replan: false is NOT replan
    const notReplan = resolveCanonicalStage(replanWf, 'scope_replan_name_only');
    expect(notReplan.replan).toBe(false);
  });

  it('W03: rejects string "false" for boolean auxiliary/replan and rejects co-declaring both', () => {
    // auxiliary: "false" must be rejected
    expect(() =>
      loadAndValidateWorkflow({
        name: 'bool-test',
        completion_policy: 'issue_delivery',
        stages: [
          {
            id: 's1',
            logical_task: 't1',
            auxiliary: 'false',
            provider: { type: 'skill', target: 'p' },
          },
        ],
      }),
    ).toThrowError(/field 'auxiliary' must be a boolean/);

    // replan: "false" must be rejected
    expect(() =>
      loadAndValidateWorkflow({
        name: 'bool-test-2',
        completion_policy: 'issue_delivery',
        stages: [
          {
            id: 's1',
            logical_task: 't1',
            replan: 'false',
            provider: { type: 'skill', target: 'p' },
          },
        ],
      }),
    ).toThrowError(/field 'replan' must be a boolean/);

    // Declaring both auxiliary: true and replan: true must be rejected
    expect(() =>
      loadAndValidateWorkflow({
        name: 'bool-test-3',
        completion_policy: 'issue_delivery',
        stages: [
          {
            id: 's1',
            logical_task: 't1',
            auxiliary: true,
            replan: true,
            provider: { type: 'skill', target: 'p' },
          },
        ],
      }),
    ).toThrowError(/cannot declare both auxiliary: true and replan: true/);
  });

  it('rejects conflicting depends_on and dependencies declarations', () => {
    expect(() =>
      loadAndValidateWorkflow({
        name: 'deps-conflict',
        completion_policy: 'issue_delivery',
        stages: [
          { id: 's1', logical_task: 't1', provider: { type: 'skill', target: 'p' } },
          {
            id: 's2',
            logical_task: 't2',
            provider: { type: 'skill', target: 'p' },
            depends_on: ['s1'],
            dependencies: ['non_existent'],
          },
        ],
      }),
    ).toThrowError(/conflicting 'depends_on' and 'dependencies'/);
  });

  it('snapshot mode strictly validates without modifying defaults or reading files', () => {
    const rawSnapshot = {
      name: 'snap',
      completion_policy: 'issue_delivery',
      stages: [
        {
          id: 's1',
          logical_task: 't1',
          provider: { type: 'skill', target: 'p1' },
          // initial_stage is omitted, auxiliary & replan omitted
        },
      ],
    };

    const validated = loadAndValidateWorkflow(rawSnapshot, undefined, 'snapshot');
    expect(validated.name).toBe('snap');
    expect(validated.initial_stage).toBeUndefined(); // Snapshot mode does NOT default initial_stage!
    expect(validated.stages[0].auxiliary).toBeUndefined(); // Snapshot mode does NOT default auxiliary!

    // Snapshot mode rejects non-object input
    expect(() => loadAndValidateWorkflow('default', undefined, 'snapshot')).toThrowError(
      /Workflow snapshot must be a valid plain object/,
    );
  });
});

describe('Dispatch Evaluation & Provider Override Rules (evaluateDispatch)', () => {
  const workflow = loadAndValidateWorkflow(); // Loads default.json
  const initialDeliveryState: DeliveryState = {
    rootIssueId: '100',
    currentIssueId: '100',
    rootBudgets: {
      delivery_attempts_used: 1,
      delivery_attempts_max: 3,
      replans_used: 0,
      replans_max: 2,
    },
  };

  it('rejects provider override for evidence-sensitive stages and protects execution arguments (F10)', () => {
    const sensitiveStages = [
      'stage_1_plan',
      'stage_2_land',
      'stage_5_redeliver',
      'issue_finalize',
      'workspace_cleanup',
      'scope_replan',
    ];

    for (const stage of sensitiveStages) {
      expect(() =>
        evaluateDispatch({
          workflow,
          deliveryState: initialDeliveryState,
          request: {
            stage,
            provider: {
              type: 'skill',
              target: 'custom-unauthorized-skill',
            },
          },
        }),
      ).toThrowError(new RegExp(`Cannot override provider for evidence-sensitive stage '${stage}'`));
    }

    // F10: Passing empty args to workspace_cleanup erases '--cleanup' and is rejected
    expect(() =>
      evaluateDispatch({
        workflow,
        deliveryState: initialDeliveryState,
        request: {
          stage: 'workspace_cleanup',
          provider: {
            type: 'skill',
            target: 'pc-workspace',
            args: [],
          },
        },
      }),
    ).toThrowError(/Cannot override provider for evidence-sensitive stage 'workspace_cleanup'/);

    // F10: Passing matching args to workspace_cleanup is accepted
    const cleanupEval = evaluateDispatch({
      workflow,
      deliveryState: initialDeliveryState,
      request: {
        stage: 'workspace_cleanup',
        provider: {
          type: 'skill',
          target: 'pc-workspace',
          args: ['--cleanup'],
        },
      },
    });
    expect(cleanupEval.task.provider.target).toBe('pc-workspace');
    expect(cleanupEval.task.provider.args).toEqual(['--cleanup']);
  });

  it('allows provider override for ordinary stages and defaults args to empty array', () => {
    const evaluation = evaluateDispatch({
      workflow,
      deliveryState: initialDeliveryState,
      request: {
        stage: 'workspace_prepare',
        provider: {
          type: 'skill',
          target: 'custom-workspace-provider',
        },
      },
    });

    expect(evaluation.task.provider.target).toBe('custom-workspace-provider');
    expect(evaluation.task.provider.args).toEqual([]);
    expect(evaluation.task.auxiliary).toBe(true);
    expect(evaluation.task.replan).toBe(false);
  });

  it('handles scope overrides and explicit empty string vs null correctly', () => {
    // Explicit null rejected
    expect(() =>
      evaluateDispatch({
        workflow,
        deliveryState: initialDeliveryState,
        request: {
          stage: 'stage_2_work',
          scope: null as unknown as string,
        },
      }),
    ).toThrowError(/Dispatch request 'scope' cannot be null/);

    // Explicit empty string clears scope
    const cleared = evaluateDispatch({
      workflow,
      deliveryState: initialDeliveryState,
      request: {
        stage: 'stage_2_work',
        scope: '',
      },
    });
    expect(cleared.task.scope).toBe('');

    // Omitted scope inherits stage scope (or empty string if undefined)
    const inherited = evaluateDispatch({
      workflow,
      deliveryState: initialDeliveryState,
      request: {
        stage: 'stage_2_work',
      },
    });
    expect(inherited.task.scope).toBe('');
  });

  it('handles receipt_template overrides and rejects null or empty string', () => {
    // Null rejected
    expect(() =>
      evaluateDispatch({
        workflow,
        deliveryState: initialDeliveryState,
        request: {
          stage: 'stage_2_work',
          receipt_template: null as unknown as string,
        },
      }),
    ).toThrowError(/Dispatch request 'receipt_template' cannot be null/);

    // Empty string rejected
    expect(() =>
      evaluateDispatch({
        workflow,
        deliveryState: initialDeliveryState,
        request: {
          stage: 'stage_2_work',
          receipt_template: '   ',
        },
      }),
    ).toThrowError(/Dispatch request 'receipt_template' cannot be empty string/);

    // Omitted falls back to DEFAULT_RECEIPT_TEMPLATE
    const omitted = evaluateDispatch({
      workflow,
      deliveryState: initialDeliveryState,
      request: {
        stage: 'stage_2_work',
      },
    });
    expect(omitted.task.receiptTemplate).toBe(DEFAULT_RECEIPT_TEMPLATE);

    // Explicit custom template preserved
    const custom = evaluateDispatch({
      workflow,
      deliveryState: initialDeliveryState,
      request: {
        stage: 'stage_2_work',
        receipt_template: '/custom/path/receipt.md',
      },
    });
    expect(custom.task.receiptTemplate).toBe('/custom/path/receipt.md');
  });

  it('shallow merges parameters and enforces identity parameter agreement (F02)', () => {
    // Conflicting repository environment default throws
    expect(() =>
      evaluateDispatch({
        workflow,
        deliveryState: initialDeliveryState,
        environmentDefaults: {
          delivery_target: 'repo/original',
        },
        request: {
          stage: 'stage_2_work',
          parameters: {
            delivery_target: 'repo/conflicting',
          },
        },
      }),
    ).toThrowError(/Conflicting parameter 'delivery_target'/);

    // F02: Stage parameters conflict with environment defaults
    const wfWithStageParam: WorkflowDefinition = {
      ...workflow,
      stages: workflow.stages.map((s) =>
        s.id === 'stage_2_work'
          ? {
              ...s,
              parameters: { delivery_target: 'repo/stage_param' },
              configs: { base_remote: 'origin' },
            }
          : s,
      ),
    };

    expect(() =>
      evaluateDispatch({
        workflow: wfWithStageParam,
        deliveryState: initialDeliveryState,
        environmentDefaults: {
          delivery_target: 'repo/env_default',
        },
        request: {
          stage: 'stage_2_work',
        },
      }),
    ).toThrowError(/Conflicting parameter 'delivery_target'/);

    // F02: Stage configs conflict with stage parameters
    const wfWithConfigConflict: WorkflowDefinition = {
      ...workflow,
      stages: workflow.stages.map((s) =>
        s.id === 'stage_2_work'
          ? {
              ...s,
              parameters: { base_remote: 'upstream' },
              configs: { base_remote: 'origin' },
            }
          : s,
      ),
    };

    expect(() =>
      evaluateDispatch({
        workflow: wfWithConfigConflict,
        deliveryState: initialDeliveryState,
        request: {
          stage: 'stage_2_work',
        },
      }),
    ).toThrowError(/Conflicting parameter 'base_remote'/);

    // F02: null cannot clear a protected parameter
    expect(() =>
      evaluateDispatch({
        workflow,
        deliveryState: initialDeliveryState,
        environmentDefaults: {
          push_remote: 'origin',
        },
        request: {
          stage: 'stage_2_work',
          parameters: {
            push_remote: null,
          },
        },
      }),
    ).toThrowError(/Protected parameter 'push_remote'.*cannot be null/);

    // F02: Repeating equal values across sources is allowed
    const equalEval = evaluateDispatch({
      workflow,
      deliveryState: initialDeliveryState,
      environmentDefaults: {
        delivery_target: 'repo/same',
      },
      request: {
        stage: 'stage_2_work',
        parameters: {
          delivery_target: 'repo/same',
        },
      },
    });
    expect(equalEval.task.parameters.delivery_target).toBe('repo/same');

    // Parameter shallow override with explicit null for ordinary param preserved
    const evalRes = evaluateDispatch({
      workflow,
      deliveryState: initialDeliveryState,
      environmentDefaults: {
        delivery_target: 'repo/main',
        base_remote: 'origin',
      },
      request: {
        stage: 'stage_2_work',
        parameters: {
          feature_flag: true,
          nullable_param: null,
        },
      },
    });

    expect(evalRes.task.parameters.delivery_target).toBe('repo/main');
    expect(evalRes.task.parameters.base_remote).toBe('origin');
    expect(evalRes.task.parameters.feature_flag).toBe(true);
    expect(evalRes.task.parameters.nullable_param).toBeNull();
  });

  it('F05: evaluateDispatch rejects ambiguous stage alias with candidate ids', () => {
    expect(() =>
      evaluateDispatch({
        workflow: baseWf,
        deliveryState: initialDeliveryState,
        request: {
          stage: 'shared_task',
        },
      }),
    ).toThrowError(
      /Ambiguous stage reference 'shared_task': matches multiple stages \('dupe_task_1', 'dupe_task_2'\)/,
    );
  });

  it('F11: inferred origin during replan is populated into task.originatingStage and task.parameters.originating_stage', () => {
    const evaluation = evaluateDispatch({
      workflow,
      deliveryState: initialDeliveryState,
      request: {
        stage: 'scope_replan',
      },
      completedStages: [
        {
          dispatch_id: 'disp_prev_work',
          stage: 'stage_2_work',
          issue_id: '100',
          execution_status: 'succeeded',
        },
      ],
    });

    expect(evaluation.task.originatingStage).toBe('stage_2_work');
    expect(evaluation.task.parameters.originating_stage).toBe('stage_2_work');
  });

  it('F12: mutating returned task parameters does not mutate request object', () => {
    const reqParameters = {
      nested: { flag: true, counts: [1, 2] },
      plain_key: 'original',
    };

    const evaluation = evaluateDispatch({
      workflow,
      deliveryState: initialDeliveryState,
      request: {
        stage: 'stage_2_work',
        parameters: reqParameters,
      },
    });

    // Mutate evaluated task parameters
    evaluation.task.parameters.plain_key = 'modified';
    (evaluation.task.parameters.nested as any).flag = false;
    (evaluation.task.parameters.nested as any).counts.push(3);

    // Verify original request parameters were completely isolated
    expect(reqParameters.plain_key).toBe('original');
    expect(reqParameters.nested.flag).toBe(true);
    expect(reqParameters.nested.counts).toEqual([1, 2]);
  });

  it('F03: classifies stage roles strictly by logical_task regardless of stage.id or provider.target', () => {
    const renamedWf = loadAndValidateWorkflow({
      name: 'f03-renamed',
      completion_policy: 'issue_delivery',
      stages: [
        { id: 'custom_prep', logical_task: 'workspace_prepare', provider: { type: 'skill', target: 'alt-prep' } },
        { id: 'custom_plan', logical_task: 'issue_plan', provider: { type: 'skill', target: 'alt-plan' } },
        { id: 'stage_2_work', logical_task: 'issue_verify', provider: { type: 'skill', target: 'alt-verify' } },
        { id: 'stage_3_verify', logical_task: 'issue_work', provider: { type: 'skill', target: 'alt-work' } },
        { id: 'custom_land', logical_task: 'issue_land', provider: { type: 'skill', target: 'alt-land' } },
        { id: 'custom_finalize', logical_task: 'issue_finalize', provider: { type: 'skill', target: 'alt-fin' } },
        { id: 'custom_cleanup', logical_task: 'workspace_cleanup', provider: { type: 'skill', target: 'alt-clean' } },
        { id: 'custom_research', logical_task: 'research_record', provider: { type: 'skill', target: 'alt-res' } },
        { id: 'custom_replan', logical_task: 'scope_replan', provider: { type: 'skill', target: 'alt-replan' } },
        { id: 'stage_1_plan', logical_task: 'custom_impl', provider: { type: 'skill', target: 'pc-issue-plan' } },
      ],
    });

    // Conflicting ID stage_2_work + logical_task issue_verify MUST behave as verification, NOT content-changing
    const conflictingVerify = resolveCanonicalStage(renamedWf, 'stage_2_work');
    expect(isVerificationStage(conflictingVerify)).toBe(true);
    expect(isContentChangingStage(conflictingVerify)).toBe(false);
    expect(allocatesDeliveryAttempt(conflictingVerify)).toBe(false);
    expect(invalidatesLanding(conflictingVerify)).toBe(false);
    expect(invalidatesVerification(conflictingVerify)).toBe(false);
    expect(isEvidenceSensitiveStage(conflictingVerify)).toBe(true);

    // Conflicting ID stage_3_verify + logical_task issue_work MUST behave as content-changing, NOT verification
    const conflictingWork = resolveCanonicalStage(renamedWf, 'stage_3_verify');
    expect(isVerificationStage(conflictingWork)).toBe(false);
    expect(isContentChangingStage(conflictingWork)).toBe(true);
    expect(allocatesDeliveryAttempt(conflictingWork)).toBe(true);
    expect(invalidatesLanding(conflictingWork)).toBe(true);
    expect(invalidatesVerification(conflictingWork)).toBe(true);
    expect(isEvidenceSensitiveStage(conflictingWork)).toBe(false);

    // Custom role with stage_1_plan ID and pc-issue-plan target MUST NOT be initial plan; defaults conservatively to content-changing
    const customImpl = resolveCanonicalStage(renamedWf, 'stage_1_plan');
    expect(isInitialPlanStage(customImpl)).toBe(false);
    expect(isContentChangingStage(customImpl)).toBe(true);
    expect(isEvidenceSensitiveStage(customImpl)).toBe(false);

    // Renamed built-in roles retain full semantics and evidence sensitivity
    expect(isAuxiliaryStage(resolveCanonicalStage(renamedWf, 'custom_prep'))).toBe(true);
    expect(isInitialPlanStage(resolveCanonicalStage(renamedWf, 'custom_plan'))).toBe(true);
    expect(isLandingStage(resolveCanonicalStage(renamedWf, 'custom_land'))).toBe(true);
    expect(isFinalizationStage(resolveCanonicalStage(renamedWf, 'custom_finalize'))).toBe(true);
    expect(isCleanupStage(resolveCanonicalStage(renamedWf, 'custom_cleanup'))).toBe(true);
    expect(isAuxiliaryStage(resolveCanonicalStage(renamedWf, 'custom_cleanup'))).toBe(true);
    expect(isResearchRecordStage(resolveCanonicalStage(renamedWf, 'custom_research'))).toBe(true);
    expect(isContentChangingStage(resolveCanonicalStage(renamedWf, 'custom_research'))).toBe(false);
    expect(isReplanStage(resolveCanonicalStage(renamedWf, 'custom_replan'))).toBe(true);

    // Provider override on renamed verification stage (stage_2_work / issue_verify) is rejected
    expect(() =>
      evaluateDispatch({
        workflow: renamedWf,
        deliveryState: initialDeliveryState,
        request: {
          stage: 'stage_2_work',
          provider: { type: 'skill', target: 'different-skill' },
        },
      }),
    ).toThrowError(/Cannot override provider for evidence-sensitive stage 'stage_2_work'/);
  });

  it('F03: rejects contradictory auxiliary/replan flags on all built-in roles in source and snapshot modes', () => {
    const nonAuxBuiltinRoles = [
      'issue_plan',
      'scope_replan',
      'issue_work',
      'pipeline_refactor_execute',
      'issue_land',
      'pipeline_refactor_redeliver',
      'issue_verify',
      'pipeline_refactor_audit',
      'issue_finalize',
      'research_record',
    ];
    const auxBuiltinRoles = ['workspace_prepare', 'workspace_cleanup'];
    const nonReplanBuiltinRoles = [
      ...auxBuiltinRoles,
      'issue_plan',
      'issue_work',
      'pipeline_refactor_execute',
      'issue_land',
      'pipeline_refactor_redeliver',
      'issue_verify',
      'pipeline_refactor_audit',
      'issue_finalize',
      'research_record',
    ];

    for (const mode of ['source', 'snapshot'] as const) {
      for (const role of nonAuxBuiltinRoles) {
        expect(() =>
          loadAndValidateWorkflow(
            {
              name: 'bad-aux',
              completion_policy: 'issue_delivery',
              stages: [{ id: 's1', logical_task: role, auxiliary: true, provider: { type: 'skill', target: 'p' } }],
            },
            undefined,
            mode,
          ),
        ).toThrowError(/cannot declare auxiliary: true/);
      }

      for (const role of auxBuiltinRoles) {
        expect(() =>
          loadAndValidateWorkflow(
            {
              name: 'bad-aux-false',
              completion_policy: 'issue_delivery',
              stages: [{ id: 's1', logical_task: role, auxiliary: false, provider: { type: 'skill', target: 'p' } }],
            },
            undefined,
            mode,
          ),
        ).toThrowError(/cannot declare auxiliary: false/);
      }

      for (const role of nonReplanBuiltinRoles) {
        expect(() =>
          loadAndValidateWorkflow(
            {
              name: 'bad-replan',
              completion_policy: 'issue_delivery',
              stages: [{ id: 's1', logical_task: role, replan: true, provider: { type: 'skill', target: 'p' } }],
            },
            undefined,
            mode,
          ),
        ).toThrowError(/cannot declare replan: true/);
      }

      expect(() =>
        loadAndValidateWorkflow(
          {
            name: 'bad-replan-false',
            completion_policy: 'issue_delivery',
            stages: [{ id: 's1', logical_task: 'scope_replan', replan: false, provider: { type: 'skill', target: 'p' } }],
          },
          undefined,
          mode,
        ),
      ).toThrowError(/cannot declare replan: false/);
    }
  });
});
