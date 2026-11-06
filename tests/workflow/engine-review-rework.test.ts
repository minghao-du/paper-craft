/**
 * @fileoverview Integration tests for Ticket #4:
 * Review and bounded rework driven deterministically by workflow definitions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  WorkflowEngine,
  computeNextStep,
} from '../../packages/core/src/workflow/engine.js';
import { DEFAULT_WORKFLOW_DEFINITION } from '../../packages/core/src/workflow/config.js';
import type {
  AgentExecutor,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStatus,
  IssueChecker,
  WorkflowDefinition,
  RoleDefinitions,
} from '../../packages/core/src/workflow/types.js';

class MockExecutor implements AgentExecutor {
  public available = true;
  public checkError?: string;
  public launchError?: string;
  public launchedTasks: Array<{ taskId: string; workingDirectory: string; prompt: string }> = [];
  public stoppedHandles: ExecutionHandle[] = [];
  public taskStatuses = new Map<string, ExecutionStatus>();

  async check(): Promise<{ available: boolean; error?: string }> {
    return { available: this.available, error: this.checkError };
  }

  async launch(taskId: string, workingDirectory: string, prompt: string): Promise<ExecutionHandle> {
    if (this.launchError) {
      throw new Error(this.launchError);
    }
    this.launchedTasks.push({ taskId, workingDirectory, prompt });
    this.taskStatuses.set(taskId, 'running');
    return {
      id: `handle-${taskId}`,
      taskId,
    };
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

  async stop(handle: ExecutionHandle): Promise<{ stopped: boolean; uncertain?: boolean }> {
    this.stoppedHandles.push(handle);
    this.taskStatuses.set(handle.taskId, 'exited');
    return { stopped: true };
  }
}

describe('Workflow MVP: Review and Bounded Rework (Ticket #4)', () => {
  let tmpDir: string;
  let mockExecutor: MockExecutor;
  let mockIssueChecker: IssueChecker;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-review-rework-test-'));
    mockExecutor = new MockExecutor();
    mockIssueChecker = {
      checkIssue: async (_repo, issue) => ({
        exists: true,
        open: true,
        title: `Test Issue #${issue}`,
      }),
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function createInitializedEngine(): Promise<WorkflowEngine> {
    const engine = new WorkflowEngine({
      cwd: tmpDir,
      issueChecker: mockIssueChecker,
      executor: mockExecutor,
    });
    await engine.init({ repository: 'test-owner/test-repo' });
    return engine;
  }

  describe('computeNextStep() deterministic unit evaluation', () => {
    it('computes forward transition from implementation to review on completed outcome', () => {
      const res = computeNextStep('implementation', 'completed', 0, 3, DEFAULT_WORKFLOW_DEFINITION);
      expect(res.nextStep).toBe('review');
      expect(res.status).toBe('running');
      expect(res.isTerminal).toBe(false);
      expect(res.isRework).toBe(false);
      expect(res.reworkCount).toBe(0);
      expect(res.reason).toBe('step_completed');
    });

    it('computes pass transition from review to merge', () => {
      const res = computeNextStep('review', 'pass', 0, 3, DEFAULT_WORKFLOW_DEFINITION);
      expect(res.nextStep).toBe('merge');
      expect(res.status).toBe('running');
      expect(res.isTerminal).toBe(false);
      expect(res.isRework).toBe(false);
      expect(res.reason).toBe('review_passed');
    });

    it('computes rework transition from review back to implementation when under limit', () => {
      const res = computeNextStep('review', 'rework', 0, 3, DEFAULT_WORKFLOW_DEFINITION);
      expect(res.nextStep).toBe('implementation');
      expect(res.status).toBe('running');
      expect(res.isTerminal).toBe(false);
      expect(res.isRework).toBe(true);
      expect(res.reworkCount).toBe(1);
      expect(res.reason).toBe('rework');
    });

    it('pauses run when rework limit is exhausted', () => {
      const res = computeNextStep('review', 'rework', 3, 3, DEFAULT_WORKFLOW_DEFINITION);
      expect(res.nextStep).toBeUndefined();
      expect(res.status).toBe('paused');
      expect(res.isTerminal).toBe(true);
      expect(res.isRework).toBe(true);
      expect(res.reworkCount).toBe(3);
      expect(res.reason).toBe('rework_limit_exhausted');
    });

    it('transitions to blocked on blocked outcome', () => {
      const res = computeNextStep('review', 'blocked', 0, 3, DEFAULT_WORKFLOW_DEFINITION);
      expect(res.nextStep).toBeUndefined();
      expect(res.status).toBe('blocked');
      expect(res.isTerminal).toBe(true);
      expect(res.isRework).toBe(false);
    });

    it('rejects outcomes not defined in step transitions', () => {
      expect(() =>
        computeNextStep('implementation', 'pass', 0, 3, DEFAULT_WORKFLOW_DEFINITION),
      ).toThrow(/Step "implementation" does not define a transition for outcome "pass"/);
    });

    it('rejects unknown step', () => {
      expect(() =>
        computeNextStep('non_existent_step', 'completed', 0, 3, DEFAULT_WORKFLOW_DEFINITION),
      ).toThrow(/Step "non_existent_step" is not defined/);
    });
  });

  describe('Pass Progression: implementation -> review -> merge', () => {
    it('drives step transitions and binds review evaluated commit', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({
        issue: 201,
        requirements: 'Add unit tests for payment webhook parser.',
      });

      // 1. Worker implements
      let sched = await engine.getSchedulingContext(run.run_id);
      expect(sched.currentStep).toBe('implementation');
      expect(sched.stepDefinition.role).toBe('worker');

      const workerTask = await engine.dispatch(run.run_id, 'Implement payment webhook parser');
      const workerSubmit = await engine.submitResult(run.run_id, workerTask.taskId, {
        outcome: 'completed',
        summary: 'Parsed webhooks and added unit tests',
        artifacts: {
          diff: 'diff --git a/webhook.ts b/webhook.ts',
          test_results: 'All 8 tests passing',
        },
      });

      expect(workerSubmit.acknowledged).toBe(true);
      expect(workerSubmit.nextStep).toBe('review');
      expect(workerSubmit.transitionStatus).toBe('running');

      // 2. Step transitions to review
      sched = await engine.getSchedulingContext(run.run_id);
      expect(sched.currentStep).toBe('review');
      expect(sched.stepDefinition.role).toBe('reviewer');
      expect(sched.roleContract.skill).toBe('pc-pr-review');
      expect(sched.stepDefinition.input_artifacts).toEqual(['diff', 'test_results']);

      // 3. Reviewer executes and approves (pass)
      const reviewTask = await engine.dispatch(run.run_id, 'Review parser against acceptance criteria');
      const reviewSubmit = await engine.submitResult(run.run_id, reviewTask.taskId, {
        outcome: 'pass',
        summary: 'Code and tests look great, ready to merge',
        artifacts: {
          reviewed_commit: 'commit-sha-abc-123',
          findings: 'No issues found; 100% test pass rate',
        },
      });

      expect(reviewSubmit.acknowledged).toBe(true);
      expect(reviewSubmit.nextStep).toBe('merge');
      expect(reviewSubmit.transitionStatus).toBe('running');

      // 4. SchedulingContext exposes pending-merge state with evaluated commit
      sched = await engine.getSchedulingContext(run.run_id);
      expect(sched.currentStep).toBe('merge');
      expect(sched.stepDefinition.role).toBe('merger');
      expect(sched.evaluatedCommit).toBe('commit-sha-abc-123');
      expect(sched.priorEvidence?.evaluatedCommit).toBe('commit-sha-abc-123');

      // Verify persisted events sequence
      const events = await engine.readEvents(run.run_id);
      const types = events.map((e) => e.type);
      expect(types).toEqual([
        'run_created',
        'dispatch_intent',
        'task_launched',
        'result_submitted',
        'task_terminated',
        'step_transitioned', // implementation -> review
        'dispatch_intent',
        'task_launched',
        'result_submitted',
        'task_terminated',
        'step_transitioned', // review -> merge
      ]);

      const reviewTransitionEvent = events[10];
      expect((reviewTransitionEvent.payload as { fromStep: string }).fromStep).toBe('review');
      expect((reviewTransitionEvent.payload as { toStep: string }).toStep).toBe('merge');
      expect((reviewTransitionEvent.payload as { outcome: string }).outcome).toBe('pass');
      expect((reviewTransitionEvent.payload as { reviewedCommit: string }).reviewedCommit).toBe('commit-sha-abc-123');
    });
  });

  describe('Review Rework: context propagation and bounded rounds', () => {
    it('carries evaluated commit and findings into rework task with fresh taskId and unchanged requirements', async () => {
      const engine = await createInitializedEngine();
      const sharedReqs = 'Immutable rule: All functions must have docstrings and zero anys.';
      const run = await engine.start({
        issue: 202,
        requirements: sharedReqs,
      });

      // 1. Initial implementation
      const task1 = await engine.dispatch(run.run_id, 'Initial implementation');
      await engine.submitResult(run.run_id, task1.taskId, {
        outcome: 'completed',
        summary: 'Implemented initial logic',
        artifacts: { diff: 'diff-1', test_results: 'Tests pass' },
      });

      // 2. Reviewer finds defects and requests rework
      const reviewTask1 = await engine.dispatch(run.run_id, 'Review initial implementation');
      const reviewSubmit = await engine.submitResult(run.run_id, reviewTask1.taskId, {
        outcome: 'rework',
        summary: 'Missing docstrings and unhandled null values',
        artifacts: {
          reviewed_commit: 'commit-sha-first-attempt',
          findings: 'Missing docstrings on export; add test for null input in parse().',
        },
      });

      expect(reviewSubmit.nextStep).toBe('implementation');
      expect(reviewSubmit.reworkCount).toBe(1);

      // 3. Scheduling context supplies orchestrator with prior evidence
      const schedRework = await engine.getSchedulingContext(run.run_id);
      expect(schedRework.currentStep).toBe('implementation');
      expect(schedRework.stepDefinition.role).toBe('worker');
      expect(schedRework.reworkCount).toBe(1);
      expect(schedRework.reworkLimit).toBe(3);
      expect(schedRework.sharedRequirements).toBe(sharedReqs);
      expect(schedRework.evaluatedCommit).toBe('commit-sha-first-attempt');
      expect(schedRework.reviewFindings).toBe('Missing docstrings on export; add test for null input in parse().');
      expect(schedRework.priorEvidence?.evaluatedCommit).toBe('commit-sha-first-attempt');

      // 4. Orchestrator dispatches rework task
      const reworkTask = await engine.dispatch(
        run.run_id,
        'Address review findings: add docstrings and null check test',
      );

      // Verify fresh taskId generated
      expect(reworkTask.taskId).not.toBe(task1.taskId);
      expect(reworkTask.taskId).toContain('implementation-1');

      // Verify worktree initialization.json carries prior evidence and unchanged requirements
      const initDataRaw = await fs.readFile(
        path.join(schedRework.worktreePath, 'initialization.json'),
        'utf8',
      );
      const initData = JSON.parse(initDataRaw);
      expect(initData.shared_requirements).toBe(sharedReqs);
      expect(initData.prior_evidence.evaluatedCommit).toBe('commit-sha-first-attempt');
      expect(initData.prior_evidence.findings).toBe(
        'Missing docstrings on export; add test for null input in parse().',
      );

      // Verify executor prompt contains review findings
      const lastLaunched = mockExecutor.launchedTasks[mockExecutor.launchedTasks.length - 1];
      expect(lastLaunched.prompt).toContain('Evaluated Commit: commit-sha-first-attempt');
      expect(lastLaunched.prompt).toContain('Missing docstrings on export; add test for null input in parse().');
      expect(lastLaunched.prompt).toContain(sharedReqs);
    });

    it('enforces at most one running professional task at a time', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 203 });

      const task = await engine.dispatch(run.run_id, 'Run implementation');

      // Attempting to dispatch another task while the first task is still running
      await expect(
        engine.dispatch(run.run_id, 'Run concurrent task'),
      ).rejects.toThrow(/Cannot dispatch: task ".*" is currently running. Run at most one professional task at a time./);

      // Submitting result terminates the active task
      await engine.submitResult(run.run_id, task.taskId, {
        outcome: 'completed',
        summary: 'Done with task',
        artifacts: { diff: 'diff-content', test_results: 'pass' },
      });

      // Now next dispatch succeeds
      const nextTask = await engine.dispatch(run.run_id, 'Review work');
      expect(nextTask.taskId).toBeDefined();
    });

    it('pauses run with preserved records when rework limit is exhausted', async () => {
      const engine = await createInitializedEngine();
      // Use configured rework_limit of 2 rounds
      const run = await engine.start({
        issue: 204,
        requirements: 'Strict requirements',
      });

      // Override run rework_limit to 2 for fast testing
      const events = await engine.readEvents(run.run_id);
      const ctx = (events[0].payload as { context: Record<string, unknown> }).context;
      (ctx.workflow as { rework_limit: number }).rework_limit = 2;
      const eventLogPath = path.join(engine.storageRoot, 'runs', run.run_id, 'events.jsonl');
      await fs.writeFile(eventLogPath, `${JSON.stringify(events[0])}\n`, 'utf8');

      // Round 0: Implementation 0
      const t0 = await engine.dispatch(run.run_id, 'Impl round 0');
      await engine.submitResult(run.run_id, t0.taskId, {
        outcome: 'completed',
        summary: 'Impl 0 done',
        artifacts: { diff: 'd0', test_results: 't0' },
      });

      // Round 1 Rework triggered by Review 0
      const r0 = await engine.dispatch(run.run_id, 'Review round 0');
      const resR0 = await engine.submitResult(run.run_id, r0.taskId, {
        outcome: 'rework',
        summary: 'Defects in round 0',
        artifacts: { reviewed_commit: 'sha-0', findings: 'findings-0' },
      });
      expect(resR0.reworkCount).toBe(1);
      expect(resR0.transitionStatus).toBe('running');

      // Implementation 1
      const t1 = await engine.dispatch(run.run_id, 'Impl round 1');
      await engine.submitResult(run.run_id, t1.taskId, {
        outcome: 'completed',
        summary: 'Impl 1 done',
        artifacts: { diff: 'd1', test_results: 't1' },
      });

      // Round 2 Rework triggered by Review 1
      const r1 = await engine.dispatch(run.run_id, 'Review round 1');
      const resR1 = await engine.submitResult(run.run_id, r1.taskId, {
        outcome: 'rework',
        summary: 'Defects in round 1',
        artifacts: { reviewed_commit: 'sha-1', findings: 'findings-1' },
      });
      expect(resR1.reworkCount).toBe(2);
      expect(resR1.transitionStatus).toBe('running');

      // Implementation 2
      const t2 = await engine.dispatch(run.run_id, 'Impl round 2');
      await engine.submitResult(run.run_id, t2.taskId, {
        outcome: 'completed',
        summary: 'Impl 2 done',
        artifacts: { diff: 'd2', test_results: 't2' },
      });

      // Review 2 triggers rework, but rework_count (2) >= rework_limit (2) => PAUSE!
      const r2 = await engine.dispatch(run.run_id, 'Review round 2');
      const resR2 = await engine.submitResult(run.run_id, r2.taskId, {
        outcome: 'rework',
        summary: 'Still defective after 2 rounds',
        artifacts: { reviewed_commit: 'sha-2', findings: 'findings-2' },
      });

      expect(resR2.transitionStatus).toBe('paused');
      expect(resR2.nextStep).toBeUndefined();

      // Check status
      const statusRes = await engine.status(run.run_id);
      expect(statusRes.status).toBe('paused');
      expect(statusRes.rework_count).toBe(2);
      expect(statusRes.summary).toContain('paused');
      expect(statusRes.summary).toMatch(/rework limit/i);

      // Dispatching while paused must be rejected
      await expect(
        engine.dispatch(run.run_id, 'Attempt dispatch on paused run'),
      ).rejects.toThrow(/Cannot dispatch: run ".*" is paused/);

      // Verify records preserved
      const runEvents = await engine.readEvents(run.run_id);
      const pausedEvent = runEvents.find((e) => e.type === 'run_paused');
      expect(pausedEvent).toBeDefined();
      expect((pausedEvent?.payload as { reason: string }).reason).toBe('rework_limit_exhausted');
      expect((pausedEvent?.payload as { artifacts: Record<string, unknown> }).artifacts.reviewed_commit).toBe('sha-2');
    });
  });

  describe('Visibility and Error Distinctness', () => {
    it('keeps blocked outcomes, provider failures, missing results, and rework distinct', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 205 });

      // Case 1: Missing results when provider exits prematurely
      const task = await engine.dispatch(run.run_id, 'Do some work');
      mockExecutor.taskStatuses.set(task.taskId, 'exited');

      let st = await engine.status(run.run_id);
      expect(st.active_task?.execution_status).toBe('exited');
      expect(st.active_task?.business_outcome).toBeUndefined();
      expect(st.summary).toContain('Warning: process exited without submitting a business result');

      // Case 2: Blocked outcome
      await engine.submitResult(run.run_id, task.taskId, {
        outcome: 'blocked',
        summary: 'Blocked on external API access key',
        artifacts: { diff: 'none', test_results: 'blocked' },
      });

      st = await engine.status(run.run_id);
      expect(st.status).toBe('blocked');
      expect(st.active_task?.business_outcome).toBe('blocked');
      expect(st.summary).toContain('blocked');

      // Case 3: Rejection on invalid outcome / artifacts for reviewer
      const run2 = await engine.start({ issue: 206 });
      const t = await engine.dispatch(run2.run_id, 'Worker work');
      await engine.submitResult(run2.run_id, t.taskId, {
        outcome: 'completed',
        summary: 'Complete',
        artifacts: { diff: 'diff', test_results: 'pass' },
      });

      const revTask = await engine.dispatch(run2.run_id, 'Review');

      // Reviewer missing reviewed_commit
      await expect(
        engine.submitResult(run2.run_id, revTask.taskId, {
          outcome: 'pass',
          summary: 'Missing reviewed_commit',
          artifacts: { findings: 'All good' },
        }),
      ).rejects.toThrow(/missing required artifact\(s\): reviewed_commit/);

      // Reviewer missing findings
      await expect(
        engine.submitResult(run2.run_id, revTask.taskId, {
          outcome: 'rework',
          summary: 'Missing findings',
          artifacts: { reviewed_commit: 'sha-x' },
        }),
      ).rejects.toThrow(/missing required artifact\(s\): findings/);
    });
  });

  describe('Ordinary Workflow / Compatible Role Definition Change', () => {
    it('demonstrates custom workflow with audit step without changing orchestrator logic', async () => {
      const customWorkflow: WorkflowDefinition = {
        initial_step: 'implementation',
        rework_limit: 3,
        steps: {
          implementation: {
            role: 'worker',
            guidance: 'Implement feature',
            transitions: {
              completed: 'security_audit',
              blocked: 'blocked',
            },
          },
          security_audit: {
            role: 'security_auditor',
            guidance: 'Run automated vulnerability scan',
            input_artifacts: ['diff'],
            transitions: {
              pass: 'review',
              rework: 'implementation',
              blocked: 'blocked',
            },
          },
          review: {
            role: 'reviewer',
            guidance: 'Review code quality',
            input_artifacts: ['diff', 'audit_report'],
            transitions: {
              pass: 'merge',
              rework: 'implementation',
              blocked: 'blocked',
            },
          },
          merge: {
            role: 'merger',
            guidance: 'Merge PR',
            transitions: {
              completed: 'completed',
              blocked: 'blocked',
            },
          },
        },
      };

      const customRoles: RoleDefinitions = {
        roles: {
          worker: {
            skill: 'pc-issue-work',
            permitted_outcomes: ['completed', 'blocked'],
            required_artifacts: ['diff', 'test_results'],
          },
          security_auditor: {
            skill: 'pc-pipeline-snakemake',
            permitted_outcomes: ['pass', 'rework', 'blocked'],
            required_artifacts: ['audit_report'],
          },
          reviewer: {
            skill: 'pc-pr-review',
            permitted_outcomes: ['pass', 'rework', 'blocked'],
            required_artifacts: ['reviewed_commit', 'findings'],
          },
          merger: {
            skill: 'pc-pr-land',
            permitted_outcomes: ['completed', 'blocked'],
            required_artifacts: ['merged_commit'],
          },
        },
      };

      const customConfig = {
        repository: 'test-owner/custom-repo',
        worktree_root: '.worktrees',
        workflow_definition: customWorkflow,
        role_definitions: customRoles,
        rework_limit: 3,
        provider: 'agy',
      };

      const configPath = path.join(tmpDir, 'custom-workflow.json');
      await fs.writeFile(configPath, JSON.stringify(customConfig, null, 2), 'utf8');

      const engine = new WorkflowEngine({
        cwd: tmpDir,
        issueChecker: mockIssueChecker,
        executor: mockExecutor,
      });

      const run = await engine.start({
        issue: 301,
        configPath,
      });

      // 1. Implementation
      let sched = await engine.getSchedulingContext(run.run_id);
      expect(sched.currentStep).toBe('implementation');
      expect(sched.stepDefinition.role).toBe('worker');

      const implTask = await engine.dispatch(run.run_id, 'Implement custom feature');
      const implRes = await engine.submitResult(run.run_id, implTask.taskId, {
        outcome: 'completed',
        summary: 'Feature implemented',
        artifacts: { diff: 'custom-diff', test_results: 'pass' },
      });

      // Next step dynamically computed as security_audit
      expect(implRes.nextStep).toBe('security_audit');
      expect(implRes.nextRole).toBe('security_auditor');

      // 2. Security audit step
      sched = await engine.getSchedulingContext(run.run_id);
      expect(sched.currentStep).toBe('security_audit');
      expect(sched.stepDefinition.role).toBe('security_auditor');
      expect(sched.roleContract.skill).toBe('pc-pipeline-snakemake');
      expect(sched.stepDefinition.input_artifacts).toEqual(['diff']);

      const auditTask = await engine.dispatch(run.run_id, 'Run security scan on diff');
      const auditRes = await engine.submitResult(run.run_id, auditTask.taskId, {
        outcome: 'pass',
        summary: 'Security scan clean, 0 CVEs',
        artifacts: { audit_report: 'clean-scan-report' },
      });

      // Next step dynamically computed as review
      expect(auditRes.nextStep).toBe('review');
      expect(auditRes.nextRole).toBe('reviewer');

      // 3. Review step
      sched = await engine.getSchedulingContext(run.run_id);
      expect(sched.currentStep).toBe('review');
      expect(sched.stepDefinition.role).toBe('reviewer');

      const revTask = await engine.dispatch(run.run_id, 'Perform code review');
      const revRes = await engine.submitResult(run.run_id, revTask.taskId, {
        outcome: 'pass',
        summary: 'Approved',
        artifacts: { reviewed_commit: 'custom-sha', findings: 'LGTM' },
      });

      expect(revRes.nextStep).toBe('merge');

      // 4. Merge step
      sched = await engine.getSchedulingContext(run.run_id);
      expect(sched.currentStep).toBe('merge');
      expect(sched.stepDefinition.role).toBe('merger');
      expect(sched.evaluatedCommit).toBe('custom-sha');
    });
  });
});
