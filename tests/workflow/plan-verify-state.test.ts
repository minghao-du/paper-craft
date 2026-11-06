/**
 * @fileoverview Tests for planning, integrated verification, pipeline refactor,
 * and research state task contracts and Run dispatch (Ticket #33).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Assignments } from '../../packages/core/src/workflow/assignments.js';
import { Run } from '../../packages/core/src/workflow/run.js';
import { initTestGitRepo } from './test-git-helper.js';
import type {
  AgentExecutor,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStatus,
} from '../../packages/core/src/workflow/types.js';

class MockControlledExecutor implements AgentExecutor {
  public launchedTasks: Array<{ taskId: string; workingDirectory: string; prompt: string }> = [];
  public taskStatuses = new Map<string, ExecutionStatus>();

  async check(): Promise<{ available: boolean }> {
    return { available: true };
  }

  async launch(taskId: string, workingDirectory: string, prompt: string): Promise<ExecutionHandle> {
    this.launchedTasks.push({ taskId, workingDirectory, prompt });
    this.taskStatuses.set(taskId, 'running');
    return { id: `handle-${taskId}`, taskId };
  }

  async inspect(taskId: string): Promise<ExecutionInspection> {
    const status = this.taskStatuses.get(taskId) ?? 'not_started';
    return {
      status,
      handle: { id: `handle-${taskId}`, taskId },
      exitCode: status === 'exited' ? 0 : undefined,
    };
  }

  async send(): Promise<void> {}

  async stop(handle: ExecutionHandle): Promise<{ stopped: boolean }> {
    this.taskStatuses.set(handle.taskId, 'exited');
    return { stopped: true };
  }
}

describe('Task Contracts: Plan, Verify, Pipeline Refactor & Research State (#33)', () => {
  let assignments: Assignments;

  beforeEach(() => {
    assignments = new Assignments();
  });

  describe('Contract Definitions & Pinned Metadata', () => {
    it('defines pc-issue-plan contract with 1.0 version and planning outcomes', () => {
      const contract = assignments.getContract('pc-issue-plan');
      expect(contract.taskType).toBe('pc-issue-plan');
      expect(contract.skill).toBe('pc-issue-plan');
      expect(contract.version).toBe('1.0');
      expect(contract.permittedOutcomes).toEqual(['direct', 'decomposed', 'blocked']);
      expect(contract.requiredInputs).toEqual(['issue', 'issueTitle', 'issueBody', 'goal']);
    });

    it('defines pc-issue-verify contract sharing pc-issue-plan skill with verification outcomes', () => {
      const contract = assignments.getContract('pc-issue-verify');
      expect(contract.taskType).toBe('pc-issue-verify');
      expect(contract.skill).toBe('pc-issue-plan');
      expect(contract.version).toBe('1.0');
      expect(contract.permittedOutcomes).toEqual(['verified', 'rework_needed', 'blocked']);
      expect(contract.requiredInputs).toEqual([
        'originalObjective',
        'acceptanceCriteria',
        'deliveryEvidence',
      ]);
    });

    it('defines pc-pipeline-refactor contract scoped to file reorganization and path sync', () => {
      const contract = assignments.getContract('pc-pipeline-refactor');
      expect(contract.taskType).toBe('pc-pipeline-refactor');
      expect(contract.skill).toBe('pc-pipeline-refactor');
      expect(contract.version).toBe('1.0');
      expect(contract.permittedOutcomes).toEqual([
        'completed',
        'no_change',
        'out_of_scope',
        'blocked',
      ]);
      expect(contract.requiredInputs).toEqual(['scope', 'migrationInstructions']);
    });

    it('defines pc-research-state contract for recording research records and reproduction entries', () => {
      const contract = assignments.getContract('pc-research-state');
      expect(contract.taskType).toBe('pc-research-state');
      expect(contract.skill).toBe('pc-research-state');
      expect(contract.version).toBe('1.0');
      expect(contract.permittedOutcomes).toEqual(['recorded', 'blocked']);
      expect(contract.requiredInputs).toEqual([
        'deliveryEvidence',
        'reproductionEntryPoints',
        'artifactLocations',
        'brief',
      ]);
    });
  });

  describe('Input Binding & Validation', () => {
    it('validates and binds required inputs for pc-issue-plan', () => {
      // Missing required inputs
      const invalid = assignments.validateInputs('pc-issue-plan', {
        issue: 10,
        issueTitle: 'Add caching',
        // missing issueBody, goal
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors).toBeDefined();
      expect(invalid.errors?.some((e) => e.includes('issueBody'))).toBe(true);
      expect(invalid.errors?.some((e) => e.includes('goal'))).toBe(true);

      // Valid inputs
      const valid = assignments.validateInputs('pc-issue-plan', {
        issue: 10,
        issueTitle: 'Add caching',
        issueBody: 'Description of problem',
        goal: 'Improve cache hit rate',
      });
      expect(valid.valid).toBe(true);
      expect(valid.errors).toBeUndefined();

      // Binding via prepare
      const prepared = assignments.prepare({
        runId: 'run-1',
        taskId: 'task-plan-1',
        taskType: 'pc-issue-plan',
        worktreePath: '/tmp/wt',
        instructions: 'Analyze issue decomposition',
        inputs: {
          issue: 10,
          issueTitle: 'Add caching',
          issueBody: 'Description of problem',
          goal: 'Improve cache hit rate',
        },
      });
      expect(prepared.initializationPayload.inputs).toEqual({
        issue: 10,
        issueTitle: 'Add caching',
        issueBody: 'Description of problem',
        goal: 'Improve cache hit rate',
      });
      expect(prepared.prompt).toContain('Task Type: pc-issue-plan');
      expect(prepared.prompt).toContain('Skill: pc-issue-plan');
      expect(prepared.prompt).toContain('Improve cache hit rate');
    });

    it('rejects prepare when required inputs are missing', () => {
      expect(() =>
        assignments.prepare({
          runId: 'run-1',
          taskId: 'task-plan-2',
          taskType: 'pc-issue-plan',
          worktreePath: '/tmp/wt',
          instructions: 'Analyze issue decomposition',
          inputs: {
            issue: 10,
          },
        }),
      ).toThrow(/Missing required input/i);
    });

    it('validates and binds required inputs for pc-issue-verify', () => {
      const invalid = assignments.validateInputs('pc-issue-verify', {
        originalObjective: 'Deliver feature X',
        // missing acceptanceCriteria, deliveryEvidence
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors?.some((e) => e.includes('acceptanceCriteria'))).toBe(true);
      expect(invalid.errors?.some((e) => e.includes('deliveryEvidence'))).toBe(true);

      const valid = assignments.validateInputs('pc-issue-verify', {
        originalObjective: 'Deliver feature X',
        acceptanceCriteria: ['All tests pass'],
        deliveryEvidence: [{ issue: 1, commitSha: 'abc1234', summary: 'Implemented X' }],
      });
      expect(valid.valid).toBe(true);
    });

    it('validates and binds required inputs for pc-pipeline-refactor', () => {
      const invalid = assignments.validateInputs('pc-pipeline-refactor', {});
      expect(invalid.valid).toBe(false);
      expect(invalid.errors?.some((e) => e.includes('scope'))).toBe(true);
      expect(invalid.errors?.some((e) => e.includes('migrationInstructions'))).toBe(true);

      const valid = assignments.validateInputs('pc-pipeline-refactor', {
        scope: ['workflow/rules/stage1.smk', 'workflow/scripts/stage1/'],
        migrationInstructions: 'Move sequential 01_ prefix to unnumbered semantic rules',
      });
      expect(valid.valid).toBe(true);
    });

    it('validates and binds required inputs for pc-research-state', () => {
      const invalid = assignments.validateInputs('pc-research-state', {
        brief: 'Record findings',
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors?.some((e) => e.includes('deliveryEvidence'))).toBe(true);
      expect(invalid.errors?.some((e) => e.includes('reproductionEntryPoints'))).toBe(true);
      expect(invalid.errors?.some((e) => e.includes('artifactLocations'))).toBe(true);

      const valid = assignments.validateInputs('pc-research-state', {
        deliveryEvidence: { commit: 'c123', tests: 'passed' },
        reproductionEntryPoints: ['bash run_eval.sh'],
        artifactLocations: ['results/benchmarks.csv'],
        brief: 'Record final benchmark results',
      });
      expect(valid.valid).toBe(true);
    });
  });

  describe('Result & Output Artifact Validation', () => {
    describe('pc-issue-plan', () => {
      it('validates direct outcome requiring reason', () => {
        // Missing reason
        const missing = assignments.validate('pc-issue-plan', {
          outcome: 'direct',
          summary: 'Atomic task',
        });
        expect(missing.valid).toBe(false);
        expect(missing.errors?.some((e) => e.includes('reason'))).toBe(true);

        // Valid direct outcome
        const valid = assignments.validate('pc-issue-plan', {
          outcome: 'direct',
          summary: 'Atomic task',
          artifacts: {
            reason: 'Single PR implementation is feasible within budget',
          },
        });
        expect(valid.valid).toBe(true);
        expect(valid.normalizedResult?.outcome).toBe('direct');
      });

      it('validates decomposed outcome requiring plan', () => {
        // Missing plan
        const missing = assignments.validate('pc-issue-plan', {
          outcome: 'decomposed',
          summary: 'Decomposed into subissues',
        });
        expect(missing.valid).toBe(false);
        expect(missing.errors?.some((e) => e.includes('plan'))).toBe(true);

        // Valid decomposed outcome
        const valid = assignments.validate('pc-issue-plan', {
          outcome: 'decomposed',
          summary: 'Decomposed into 2 subissues',
          artifacts: {
            plan: {
              tasks: [
                { title: 'Subissue 1', brief: 'Scaffold schemas', blockedBy: [] },
                { title: 'Subissue 2', brief: 'Implement logic', blockedBy: ['Subissue 1'] },
              ],
            },
          },
        });
        expect(valid.valid).toBe(true);
        expect(valid.normalizedResult?.artifacts?.plan).toBeDefined();
      });

      it('rejects disallowed outcomes', () => {
        const res = assignments.validate('pc-issue-plan', {
          outcome: 'landed',
          summary: 'Should not be allowed here',
        });
        expect(res.valid).toBe(false);
        expect(res.errors?.some((e) => e.includes('not permitted'))).toBe(true);
      });
    });

    describe('pc-issue-verify', () => {
      it('validates verified outcome requiring evaluatedHead and evidence', () => {
        // Missing evaluatedHead
        const missingHead = assignments.validate('pc-issue-verify', {
          outcome: 'verified',
          summary: 'Verified deliverables',
          artifacts: { evidence: 'All acceptance gates pass' },
        });
        expect(missingHead.valid).toBe(false);
        expect(missingHead.errors?.some((e) => e.includes('evaluatedHead'))).toBe(true);

        // Missing evidence
        const missingEv = assignments.validate('pc-issue-verify', {
          outcome: 'verified',
          summary: 'Verified deliverables',
          artifacts: { evaluatedHead: 'sha999' },
        });
        expect(missingEv.valid).toBe(false);
        expect(missingEv.errors?.some((e) => e.includes('evidence'))).toBe(true);

        // Valid verified outcome
        const valid = assignments.validate('pc-issue-verify', {
          outcome: 'verified',
          summary: 'Verified against original objective',
          artifacts: {
            evaluatedHead: 'sha999',
            evidence: 'Unit tests (10/10) and CLI smoke tests pass without errors',
          },
        });
        expect(valid.valid).toBe(true);
        expect(valid.normalizedResult?.outcome).toBe('verified');
      });

      it('validates rework_needed outcome requiring evidence and reporting gaps', () => {
        // Missing evidence
        const missingEv = assignments.validate('pc-issue-verify', {
          outcome: 'rework_needed',
          summary: 'Gaps identified',
        });
        expect(missingEv.valid).toBe(false);
        expect(missingEv.errors?.some((e) => e.includes('evidence'))).toBe(true);

        // Valid rework_needed outcome
        const valid = assignments.validate('pc-issue-verify', {
          outcome: 'rework_needed',
          summary: 'Gaps found in CLI flag handling',
          artifacts: {
            evidence: 'Test suite failed on --format json flag',
            gaps: ['Flag --format json produces malformed output'],
          },
        });
        expect(valid.valid).toBe(true);
        expect(valid.normalizedResult?.outcome).toBe('rework_needed');
      });
    });

    describe('pc-pipeline-refactor', () => {
      it('validates completed outcome requiring changedFiles and verificationEvidence', () => {
        const missing = assignments.validate('pc-pipeline-refactor', {
          outcome: 'completed',
          summary: 'Reorganized files',
          artifacts: { changedFiles: ['workflow/rules/stage.smk'] },
        });
        expect(missing.valid).toBe(false);
        expect(missing.errors?.some((e) => e.includes('verificationEvidence'))).toBe(true);

        const valid = assignments.validate('pc-pipeline-refactor', {
          outcome: 'completed',
          summary: 'Reorganized rules and synced paths',
          artifacts: {
            changedFiles: ['workflow/rules/stage.smk', 'workflow/scripts/stage/main.py'],
            verificationEvidence: 'Snakemake dry-run -n resolved DAG with 0 errors',
          },
        });
        expect(valid.valid).toBe(true);
        expect(valid.normalizedResult?.outcome).toBe('completed');
      });

      it('validates no_change outcome requiring verificationEvidence', () => {
        const missing = assignments.validate('pc-pipeline-refactor', {
          outcome: 'no_change',
          summary: 'Layout already conforms to standard',
        });
        expect(missing.valid).toBe(false);
        expect(missing.errors?.some((e) => e.includes('verificationEvidence'))).toBe(true);

        const valid = assignments.validate('pc-pipeline-refactor', {
          outcome: 'no_change',
          summary: 'Layout already conforms to standard',
          artifacts: {
            verificationEvidence: 'Inspected workflow/ layout; zero sequential prefixes present',
          },
        });
        expect(valid.valid).toBe(true);
        expect(valid.normalizedResult?.outcome).toBe('no_change');
      });

      it('validates out_of_scope outcome without requiring file changes', () => {
        const valid = assignments.validate('pc-pipeline-refactor', {
          outcome: 'out_of_scope',
          summary: 'Refactoring requires changing statistical model parameters, which is out of scope for default file reorganization',
        });
        expect(valid.valid).toBe(true);
        expect(valid.normalizedResult?.outcome).toBe('out_of_scope');
      });
    });

    describe('pc-research-state', () => {
      it('validates recorded outcome requiring updatedRecords', () => {
        const missing = assignments.validate('pc-research-state', {
          outcome: 'recorded',
          summary: 'Recorded state',
        });
        expect(missing.valid).toBe(false);
        expect(missing.errors?.some((e) => e.includes('updatedRecords'))).toBe(true);

        const valid = assignments.validate('pc-research-state', {
          outcome: 'recorded',
          summary: 'Updated research state with reproduction entries and benchmark tables',
          artifacts: {
            updatedRecords: ['research-state/RESEARCH-STATE.local.md'],
          },
        });
        expect(valid.valid).toBe(true);
        expect(valid.normalizedResult?.outcome).toBe('recorded');
      });
    });
  });

  describe('Run Dispatch & Lifecycle Integration', () => {
    let tmpDir: string;
    let repoDir: string;
    let storageRoot: string;
    let executor: MockControlledExecutor;
    let run: Run;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-run-plan-verify-'));
      repoDir = path.join(tmpDir, 'repo');
      storageRoot = path.join(tmpDir, 'storage');
      await fs.mkdir(repoDir, { recursive: true });
      await fs.mkdir(storageRoot, { recursive: true });
      await initTestGitRepo(repoDir);
      executor = new MockControlledExecutor();

      run = await Run.open({
        runId: 'run-test-pv',
        repository: 'owner/test-repo',
        issue: 100,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('dispatches pc-issue-plan, observes result from worktree, and validates decomposed plan', async () => {
      const dispatchSummary = await run.dispatch({
        taskType: 'pc-issue-plan',
        instructions: 'Evaluate decomposition for root issue',
        inputs: {
          issue: 100,
          issueTitle: 'Major feature',
          issueBody: 'Description of major feature',
          goal: 'Implement end-to-end',
        },
      });

      expect(dispatchSummary.taskType).toBe('pc-issue-plan');
      expect(executor.launchedTasks.length).toBe(1);
      expect(executor.launchedTasks[0].prompt).toContain('Task Type: pc-issue-plan');
      expect(executor.launchedTasks[0].prompt).toContain('Implement end-to-end');

      // Worker writes result.json in worktree
      const resultPayload = {
        outcome: 'decomposed',
        summary: 'Decomposed into 2 sub-issues',
        artifacts: {
          plan: {
            tasks: [
              { title: 'Subtask 1', brief: 'First part', blockedBy: [] },
              { title: 'Subtask 2', brief: 'Second part', blockedBy: ['Subtask 1'] },
            ],
          },
        },
      };
      await fs.writeFile(
        path.join(dispatchSummary.worktreePath, 'result.json'),
        JSON.stringify(resultPayload, null, 2),
        'utf8',
      );

      // Simulate executor task exit
      executor.taskStatuses.set(dispatchSummary.taskId, 'exited');

      // Observe via Run facade
      const observation = await run.observe(dispatchSummary.taskId);
      expect(observation.hasSubmittedResult).toBe(true);
      expect(observation.result?.outcome).toBe('decomposed');
      expect(observation.result?.summary).toBe('Decomposed into 2 sub-issues');
      expect(observation.result?.artifacts?.plan).toBeDefined();
    });

    it('dispatches pc-issue-verify and confirms verified acceptance evidence without scheduling repairs', async () => {
      const dispatchSummary = await run.dispatch({
        taskType: 'pc-issue-verify',
        instructions: 'Verify combined deliveries against parent objective',
        inputs: {
          originalObjective: 'Parent goal of Ticket 100',
          acceptanceCriteria: ['All subtasks delivered and merged', 'Integration tests pass'],
          deliveryEvidence: [
            { issue: 101, commitSha: 'sha101', summary: 'Subtask 1 complete' },
            { issue: 102, commitSha: 'sha102', summary: 'Subtask 2 complete' },
          ],
        },
      });

      expect(dispatchSummary.taskType).toBe('pc-issue-verify');
      expect(executor.launchedTasks.length).toBe(1);
      expect(executor.launchedTasks[0].prompt).toContain('Skill: pc-issue-plan');

      // Worker writes verified result
      const resultPayload = {
        outcome: 'verified',
        summary: 'All child deliverables satisfy parent criteria',
        artifacts: {
          evaluatedHead: 'sha102',
          evidence: 'Verified integration test suite: 24/24 tests pass on merged commit sha102',
        },
      };
      await fs.writeFile(
        path.join(dispatchSummary.worktreePath, 'result.json'),
        JSON.stringify(resultPayload, null, 2),
        'utf8',
      );

      executor.taskStatuses.set(dispatchSummary.taskId, 'exited');

      const observation = await run.observe(dispatchSummary.taskId);
      expect(observation.hasSubmittedResult).toBe(true);
      expect(observation.result?.outcome).toBe('verified');
      expect(observation.result?.artifacts?.evaluatedHead).toBe('sha102');
    });

    it('dispatches pc-pipeline-refactor and records file reorganization verification', async () => {
      const dispatchSummary = await run.dispatch({
        taskType: 'pc-pipeline-refactor',
        instructions: 'Reorganize workflow pipeline directories and sync path references',
        inputs: {
          scope: ['workflow/rules/stage1.smk', 'workflow/scripts/stage1/'],
          migrationInstructions: 'Remove sequential numbers and mirror results hierarchy',
        },
      });

      expect(dispatchSummary.taskType).toBe('pc-pipeline-refactor');

      // Worker writes result indicating completed reorganization without touching scientific computation
      const resultPayload = {
        outcome: 'completed',
        summary: 'Reorganized rules and scripts into unnumbered submodules and synced paths',
        artifacts: {
          changedFiles: ['workflow/rules/stage1.smk', 'workflow/scripts/stage1/transform.py'],
          verificationEvidence: 'Small-data smoke check passed; DAG dry-run resolved with 0 errors',
        },
      };
      await fs.writeFile(
        path.join(dispatchSummary.worktreePath, 'result.json'),
        JSON.stringify(resultPayload, null, 2),
        'utf8',
      );

      executor.taskStatuses.set(dispatchSummary.taskId, 'exited');

      const observation = await run.observe(dispatchSummary.taskId);
      expect(observation.hasSubmittedResult).toBe(true);
      expect(observation.result?.outcome).toBe('completed');
      expect(Array.isArray(observation.result?.artifacts?.changedFiles)).toBe(true);
    });

    it('dispatches pc-research-state and records reproduction entries and delivery evidence', async () => {
      const dispatchSummary = await run.dispatch({
        taskType: 'pc-research-state',
        instructions: 'Record final research state and reproduction entry points',
        inputs: {
          deliveryEvidence: { commit: 'sha102', tests: 'all pass' },
          reproductionEntryPoints: ['bash scripts/reproduce.sh'],
          artifactLocations: ['results/benchmark-summary.tsv'],
          brief: 'Record delivery benchmark results',
        },
      });

      expect(dispatchSummary.taskType).toBe('pc-research-state');

      // Worker writes recorded result
      const resultPayload = {
        outcome: 'recorded',
        summary: 'Recorded final reproduction entry points and benchmark artifact pointers',
        artifacts: {
          updatedRecords: ['research-state/RESEARCH-STATE.local.md'],
        },
      };
      await fs.writeFile(
        path.join(dispatchSummary.worktreePath, 'result.json'),
        JSON.stringify(resultPayload, null, 2),
        'utf8',
      );

      executor.taskStatuses.set(dispatchSummary.taskId, 'exited');

      const observation = await run.observe(dispatchSummary.taskId);
      expect(observation.hasSubmittedResult).toBe(true);
      expect(observation.result?.outcome).toBe('recorded');
      expect(observation.result?.artifacts?.updatedRecords).toEqual([
        'research-state/RESEARCH-STATE.local.md',
      ]);
    });
  });
});
