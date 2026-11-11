/**
 * Dispatch Lifecycle Verification Suite (T1-T6, B2.9).
 * Covers core lifecycle state machine, allocation, authorization, recovery, and budget enforcement.
 * Adheres to AGENTS.md and pc-test-budget (<120s runtime ceiling).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  completeDispatch,
  handoffDispatch,
  initWorkflow,
  inspectState,
  prepareTask,
  resolveDecision,
} from '../src/lifecycle/index.js';
import {
  getPendingCommitPath,
  getStateFilePath,
  loadRun,
} from '../src/run-store/index.js';
import {
  createTestDir,
  runLifecycleKernelCli,
  runPrepareTaskCli,
} from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Dispatch Lifecycle Verification (T1-T6, B2.9)', () => {
  // T1: init -> prepare -> handoff -> complete -> inspect
  it('T1: complete lifecycle execution allocates, authorizes, completes, and clears active dispatch', () => {
    const env = createTestDir('pc-t1-');
    try {
      const state = initWorkflow({
        receipt_root: env.dir,
        root_issue: 101,
      });
      expect(state.root_issue_id).toBe('101');

      const prepared = prepareTask({
        receipt_root: env.dir,
        stage: 'workspace_prepare',
        objective: 'Prepare initial workspace',
        provider: { type: 'skill', target: 'pc-workspace' },
        workdir: env.dir,
      });
      expect(prepared.dispatch_id).toBeDefined();
      expect(prepared.status).toBe('prepared');

      const handoff = handoffDispatch({
        receipt_root: env.dir,
        dispatch_id: prepared.dispatch_id,
      });
      expect(handoff.authorized).toBe(true);
      expect(handoff.status).toBe('handed_off');

      // Write valid receipt to disk
      fs.writeFileSync(prepared.receipt_path, '# Workspace Receipt\nOutcome: prepared\n');

      const completed = completeDispatch({
        receipt_root: env.dir,
        dispatch_id: prepared.dispatch_id,
        report: {
          execution_status: 'succeeded',
          result: { outcome: 'prepared' },
          receipt_path: prepared.receipt_path,
          summary: 'Workspace prepared successfully.',
        },
      });
      expect(completed.execution_status).toBe('succeeded');

      const inspected = inspectState({ receipt_root: env.dir }) as Record<string, unknown>;
      expect(inspected.active_dispatch).toBeNull();
      expect(inspected.completed_stages_count).toBe(1);
      // Verify stage did not auto-advance before resolve
      expect(inspected.current_stage).toBe('workspace_prepare');
    } finally {
      env.cleanup();
    }
  }, 20000);

  // T2: prepare deduplication and semantic variation rejection
  it('T2: prepare reuses ID on identical request but rejects reuse on semantic mutation', () => {
    const env = createTestDir('pc-t2-');
    try {
      initWorkflow({
        receipt_root: env.dir,
        root_issue: 102,
      });

      const req1 = {
        receipt_root: env.dir,
        stage: 'stage_1_plan',
        objective: 'Plan task',
        provider: { type: 'skill' as const, target: 'pc-issue-plan' },
        workdir: env.dir,
        scope: 'initial scope',
        parameters: { key: 'val1' },
      };

      const prep1 = prepareTask(req1);
      expect(prep1.attempt).toBe(1);

      // Identical request should reuse existing prepared dispatch
      const prepDuplicate = prepareTask(req1);
      expect(prepDuplicate.dispatch_id).toBe(prep1.dispatch_id);

      // Modifying scope should be rejected while an active dispatch exists with different semantics
      expect(() => {
        prepareTask({
          ...req1,
          scope: 'changed scope',
        });
      }).toThrow(/conflict|Cannot prepare task/i);

      // Modifying parameters should be rejected similarly
      expect(() => {
        prepareTask({
          ...req1,
          parameters: { key: 'val2' },
        });
      }).toThrow(/conflict|Cannot prepare task/i);
    } finally {
      env.cleanup();
    }
  }, 20000);

  // T3: handoff and complete duplicate, mismatch, and error ID enforcement
  it('T3: enforces single authorization, idempotent completion, and rejects mismatched IDs', () => {
    const env = createTestDir('pc-t3-');
    try {
      initWorkflow({
        receipt_root: env.dir,
        root_issue: 103,
      });

      const prep = prepareTask({
        receipt_root: env.dir,
        stage: 'stage_1_plan',
        objective: 'Plan task',
        provider: { type: 'skill', target: 'pc-issue-plan' },
        workdir: env.dir,
      });

      // Wrong dispatch_id for handoff must throw
      expect(() => {
        handoffDispatch({
          receipt_root: env.dir,
          dispatch_id: 'wrong-dispatch-id',
        });
      }).toThrow(/does not match requested dispatch ID/i);

      // First handoff succeeds with authorized: true
      const h1 = handoffDispatch({
        receipt_root: env.dir,
        dispatch_id: prep.dispatch_id,
      });
      expect(h1.authorized).toBe(true);

      // Second handoff returns authorized: false without throwing
      const h2 = handoffDispatch({
        receipt_root: env.dir,
        dispatch_id: prep.dispatch_id,
      });
      expect(h2.authorized).toBe(false);

      // Complete with wrong dispatch_id throws
      fs.writeFileSync(prep.receipt_path, '# Plan Receipt\n');
      const report = {
        execution_status: 'succeeded' as const,
        result: { outcome: 'direct' },
        receipt_path: prep.receipt_path,
        summary: 'Direct plan established',
      };

      expect(() => {
        completeDispatch({
          receipt_root: env.dir,
          dispatch_id: 'wrong-dispatch-id',
          report,
        });
      }).toThrow(/does not match requested/i);

      // First complete succeeds
      const c1 = completeDispatch({
        receipt_root: env.dir,
        dispatch_id: prep.dispatch_id,
        report,
      });
      expect(c1.execution_status).toBe('succeeded');

      // Repeated complete with identical report is idempotent and succeeds
      const c2 = completeDispatch({
        receipt_root: env.dir,
        dispatch_id: prep.dispatch_id,
        report,
      });
      expect(c2.execution_status).toBe('succeeded');

      // Repeated complete with contradictory report is rejected
      expect(() => {
        completeDispatch({
          receipt_root: env.dir,
          dispatch_id: prep.dispatch_id,
          report: {
            ...report,
            execution_status: 'failed' as const,
          },
        });
      }).toThrow(/conflicting report/i);
    } finally {
      env.cleanup();
    }
  }, 20000);

  // T4: prepare pending commit crash recovery
  it('T4: recovers interrupted prepare commit from pending-commit record without duplicate budget consumption', () => {
    const env = createTestDir('pc-t4-');
    try {
      const state0 = initWorkflow({
        receipt_root: env.dir,
        root_issue: 104,
      });

      // Prepare normally
      const prep = prepareTask({
        receipt_root: env.dir,
        stage: 'stage_1_plan',
        objective: 'Plan task',
        provider: { type: 'skill', target: 'pc-issue-plan' },
        workdir: env.dir,
      });

      const loadedState = loadRun<typeof state0>(env.dir);
      const envelopeContent = JSON.parse(fs.readFileSync(prep.envelope_path, 'utf8'));

      // Simulate a crash right after writing pending-commit.json (with state reverted to state0)
      const pendingPath = getPendingCommitPath(env.dir);
      const pendingRecord = {
        version: '1.0',
        expected_previous_state: state0,
        target_state: loadedState,
        envelope: {
          filename: path.basename(prep.envelope_path),
          content: envelopeContent,
        },
      };

      // Revert state.json to state0 and write pending-commit.json
      fs.writeFileSync(getStateFilePath(env.dir), JSON.stringify(state0));
      fs.writeFileSync(pendingPath, JSON.stringify(pendingRecord));

      // loadRun should detect pending-commit, complete the target state, and remove pending-commit
      const recoveredState = loadRun<typeof state0>(env.dir);
      expect(recoveredState.active_dispatch?.dispatch_id).toBe(prep.dispatch_id);
      expect(fs.existsSync(pendingPath)).toBe(false);

      // A subsequent loadRun is consistent and produces no additional budget consumption
      const secondLoad = loadRun<typeof state0>(env.dir);
      expect(secondLoad.budgets.delivery_attempts_used).toBe(recoveredState.budgets.delivery_attempts_used);
    } finally {
      env.cleanup();
    }
  }, 20000);

  // T5: delivery and replan budgets integrity
  it('T5: preserves delivery and replanning budget invariants across operations', () => {
    const env = createTestDir('pc-t5-');
    try {
      initWorkflow({
        receipt_root: env.dir,
        root_issue: 105,
        delivery_attempts_max: 3,
        replans_max: 2,
      });

      const state1 = loadRun<Record<string, unknown>>(env.dir);
      expect(state1.budgets.delivery_attempts_used).toBe(0);
      expect(state1.budgets.replans_used).toBe(0);

      const p1 = prepareTask({
        receipt_root: env.dir,
        stage: 'stage_1_plan',
        objective: 'Plan stage',
        provider: { type: 'skill', target: 'pc-issue-plan' },
        workdir: env.dir,
      });

      const state2 = loadRun<Record<string, unknown>>(env.dir);
      expect(state2.budgets.delivery_attempts_used).toBe(1);

      handoffDispatch({ receipt_root: env.dir, dispatch_id: p1.dispatch_id });
      fs.writeFileSync(p1.receipt_path, '# Plan\n');
      completeDispatch({
        receipt_root: env.dir,
        dispatch_id: p1.dispatch_id,
        report: {
          execution_status: 'succeeded',
          result: { outcome: 'direct' },
          receipt_path: p1.receipt_path,
          summary: 'Plan done',
        },
      });

      // Replan decision
      resolveDecision({
        receipt_root: env.dir,
        decision: 'continue',
        reason: 'Scope adjustment required',
        next_stage: 'stage_1_plan',
      });

      const state3 = loadRun<Record<string, unknown>>(env.dir);
      expect(state3.budgets.delivery_attempts_used).toBe(1);
    } finally {
      env.cleanup();
    }
  }, 20000);

  // T6: Unknown workflow, unknown decision rejection, and completion policy verification
  it('T6: rejects unknown workflows and invalid decisions; validates completion_policy', () => {
    const env = createTestDir('pc-t6-');
    try {
      // 1. Unknown workflow name must fail without fallback
      expect(() => {
        initWorkflow({
          receipt_root: env.dir,
          root_issue: 106,
          workflow: 'non_existent_workflow_xyz',
        });
      }).toThrow(/Workflow file not found/i);

      // 2. Initialize with basic workflow fixture
      const fixturePath = path.resolve(__dirname, 'fixtures/three-stage-fixture.json');
      initWorkflow({
        receipt_root: env.dir,
        root_issue: 106,
        workflow: fixturePath,
      });

      // 3. Reject invalid decision via CLI/function
      expect(() => {
        resolveDecision({
          receipt_root: env.dir,
          decision: 'stage_2_work' as unknown as 'continue',
          reason: 'Attempting stage name as decision',
        });
      }).toThrow(/Invalid decision 'stage_2_work'/i);

      // 4. Test completion_policy: "basic" allows finish when active dispatch is null
      const finishRes = resolveDecision({
        receipt_root: env.dir,
        decision: 'finish',
        reason: 'Basic workflow finished',
      });
      expect(finishRes.decision).toBe('finish');

      const finalState = loadRun<Record<string, unknown>>(env.dir);
      expect(finalState.current_stage).toBe('completed');
    } finally {
      env.cleanup();
    }
  }, 20000);

  // B2.9: state machine check-budget halts when budget limit is reached
  it('B2.9: state machine check-budget halts when budget limit is reached', () => {
    const env = createTestDir('pc-b29-');
    try {
      runLifecycleKernelCli([
        'init',
        '--receipt-root', env.dir,
        '--root-issue', '500',
        '--delivery-attempts-max', '3',
      ]);

      // Budget starts at 0/3
      const checkOk = runLifecycleKernelCli([
        'inspect',
        '--receipt-root', env.dir,
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
      const p1 = runPrepareTaskCli(env.dir, {
        stage: 'stage_2_work',
        objective: 'Task 1',
        provider: {
          type: 'skill',
          target: 'pc-issue-work',
        },
      });
      const p1Data = JSON.parse(p1.stdout);
      runLifecycleKernelCli(['handoff', '--receipt-root', env.dir, '--dispatch-id', p1Data.dispatch_id]);
      fs.writeFileSync(p1Data.receipt_path, '# Receipt 1');
      runLifecycleKernelCli([
        'complete',
        '--receipt-root', env.dir,
        '--dispatch-id', p1Data.dispatch_id,
        '--report', JSON.stringify({
          execution_status: 'failed',
          result: {},
          receipt_path: p1Data.receipt_path,
          summary: 'Attempt 1 failed',
        }),
      ]);

      // Attempt 2
      const p2 = runPrepareTaskCli(env.dir, {
        stage: 'stage_2_work',
        objective: 'Task 1',
        provider: {
          type: 'skill',
          target: 'pc-issue-work',
        },
        attempt_intent: 'new',
      });
      const p2Data = JSON.parse(p2.stdout);
      runLifecycleKernelCli(['handoff', '--receipt-root', env.dir, '--dispatch-id', p2Data.dispatch_id]);
      fs.writeFileSync(p2Data.receipt_path, '# Receipt 2');
      runLifecycleKernelCli([
        'complete',
        '--receipt-root', env.dir,
        '--dispatch-id', p2Data.dispatch_id,
        '--report', JSON.stringify({
          execution_status: 'failed',
          result: {},
          receipt_path: p2Data.receipt_path,
          summary: 'Attempt 2 failed',
        }),
      ]);

      // Attempt 3
      const p3 = runPrepareTaskCli(env.dir, {
        stage: 'stage_2_work',
        objective: 'Task 1',
        provider: {
          type: 'skill',
          target: 'pc-issue-work',
        },
        attempt_intent: 'new',
      });
      const p3Data = JSON.parse(p3.stdout);
      runLifecycleKernelCli(['handoff', '--receipt-root', env.dir, '--dispatch-id', p3Data.dispatch_id]);
      fs.writeFileSync(p3Data.receipt_path, '# Receipt 3');
      runLifecycleKernelCli([
        'complete',
        '--receipt-root', env.dir,
        '--dispatch-id', p3Data.dispatch_id,
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
        '--receipt-root', env.dir,
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
    } finally {
      env.cleanup();
    }
  }, 20000);
});
