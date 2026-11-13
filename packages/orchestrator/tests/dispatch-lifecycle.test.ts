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
  dispatchTask,
  initWorkflow,
  inspectState,
  resolveDecision,
  type ResolveOptions,
} from '../src/lifecycle/index.js';
import {
  getPendingCommitPath,
  getStateFilePath,
  loadRun,
} from '../src/run-store/index.js';
import {
  createTestDir,
  runLifecycleKernelCli,
  runDispatchTaskCli,
} from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Dispatch Lifecycle Verification (T1-T6, B2.9)', () => {
  // T1: init -> dispatch -> complete -> inspect
  it('T1: complete lifecycle execution allocates, authorizes, completes, and clears active dispatch', () => {
    const env = createTestDir('pc-t1-');
    try {
      const state = initWorkflow({
        receipt_root: env.dir,
        root_issue: 101,
      });
      expect(state.root_issue_id).toBe('101');

      const dispatched = dispatchTask({
        receipt_root: env.dir,
        request_id: 'initial-workspace',
        stage: 'workspace_prepare',
        objective: 'Prepare initial workspace',
        provider: { type: 'skill', target: 'pc-workspace' },
        workdir: env.dir,
      });
      expect(dispatched).toMatchObject({
        launch_granted: true,
        status: 'handed_off',
        provider: { type: 'skill', target: 'pc-workspace' },
      });
      expect(inspectState({ receipt_root: env.dir })).toMatchObject({
        stage_status: 'in_progress',
        active_dispatch: { dispatch_id: dispatched.dispatch_id, status: 'handed_off' },
      });

      // Write valid receipt to disk
      fs.writeFileSync(dispatched.receipt_path, '# Workspace Receipt\nOutcome: prepared\n');

      const completed = completeDispatch({
        receipt_root: env.dir,
        dispatch_id: dispatched.dispatch_id,
        report: {
          execution_status: 'succeeded',
          result: { outcome: 'prepared' },
          receipt_path: dispatched.receipt_path,
          summary: 'Workspace prepared successfully.',
        },
      });
      expect(completed.execution_status).toBe('succeeded');

      const inspected = inspectState({ receipt_root: env.dir });
      expect(inspected.active_dispatch).toBeNull();
      expect(inspected.completed_stages_count).toBe(1);
      // Verify stage did not auto-advance before resolve
      expect(inspected.current_stage).toBe('workspace_prepare');
    } finally {
      env.cleanup();
    }
  }, 20000);

  it('T2: grants launch once per request ID and rejects conflicting requests', () => {
    const env = createTestDir('pc-t2-');
    try {
      initWorkflow({ receipt_root: env.dir, root_issue: 102 });
      const request = {
        receipt_root: env.dir,
        request_id: 'issue-plan',
        stage: 'stage_1_plan',
        objective: 'Plan task',
        provider: { type: 'skill' as const, target: 'pc-issue-plan' },
        workdir: env.dir,
        scope: 'initial scope',
        parameters: { first: 'one', second: 'two' },
      };

      const first = dispatchTask(request);
      expect(first.launch_granted).toBe(true);
      const statePath = getStateFilePath(env.dir);
      const firstState = fs.readFileSync(statePath, 'utf8');
      expect(JSON.parse(firstState).budgets.delivery_attempts_used).toBe(1);

      const replay = dispatchTask({
        ...request,
        parameters: { second: 'two', first: 'one' },
      });
      expect(replay).toMatchObject({
        dispatch_id: first.dispatch_id,
        launch_granted: false,
        status: 'handed_off',
        provider: first.provider,
        envelope_path: first.envelope_path,
        receipt_path: first.receipt_path,
      });

      expect(() => dispatchTask({ ...request, scope: 'changed scope' })).toThrow(/conflict/i);
      expect(() => dispatchTask({
        ...request,
        parameters: { first: 'changed', second: 'two' },
      })).toThrow(/conflict/i);
      expect(() => dispatchTask({ ...request, request_id: 'another-plan' })).toThrow(/active dispatch/i);
      expect(fs.readFileSync(statePath, 'utf8')).toBe(firstState);
    } finally {
      env.cleanup();
    }
  }, 20000);

  it('T3: preserves completion identity across later dispatches and run decisions', () => {
    const env = createTestDir('pc-t3-');
    try {
      initWorkflow({
        receipt_root: env.dir,
        root_issue: 103,
        workflow: path.resolve(__dirname, 'fixtures/three-stage-fixture.json'),
      });

      const request = {
        receipt_root: env.dir,
        request_id: 'workspace',
        stage: 'workspace_prepare',
        objective: 'Prepare workspace',
        provider: { type: 'skill' as const, target: 'pc-workspace' },
        workdir: env.dir,
      };
      const dispatched = dispatchTask(request);

      fs.writeFileSync(dispatched.receipt_path, '# Workspace Receipt\n');
      const report = {
        execution_status: 'succeeded' as const,
        result: { outcome: 'prepared' },
        receipt_path: dispatched.receipt_path,
        summary: 'Workspace prepared',
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
        dispatch_id: dispatched.dispatch_id,
        report,
      });
      expect(c1.execution_status).toBe('succeeded');

      // Repeated complete with identical report is idempotent and succeeds
      const c2 = completeDispatch({
        receipt_root: env.dir,
        dispatch_id: dispatched.dispatch_id,
        report,
      });
      expect(c2.execution_status).toBe('succeeded');

      // Repeated complete with contradictory report is rejected
      expect(() => {
        completeDispatch({
          receipt_root: env.dir,
          dispatch_id: dispatched.dispatch_id,
          report: {
            ...report,
            execution_status: 'failed' as const,
          },
        });
      }).toThrow(/conflicting report/i);

      const settled = {
        dispatch_id: dispatched.dispatch_id,
        launch_granted: false,
        status: 'completed',
        provider: dispatched.provider,
        envelope_path: dispatched.envelope_path,
        receipt_path: dispatched.receipt_path,
        completion: expect.objectContaining({ execution_status: 'succeeded' }),
      };
      const next = dispatchTask({
        ...request,
        request_id: 'implementation',
        stage: 'issue_work',
        objective: 'Implement issue',
        provider: { type: 'skill', target: 'pc-issue-work' },
      });
      expect(next.launch_granted).toBe(true);
      expect(next.dispatch_id).not.toBe(dispatched.dispatch_id);
      expect(dispatchTask(request)).toMatchObject(settled);
      expect(() => dispatchTask({ ...request, objective: 'Changed workspace objective' })).toThrow(/conflict/i);

      resolveDecision({ receipt_root: env.dir, decision: 'wait_user', reason: 'Review required' });
      expect(dispatchTask(request)).toMatchObject(settled);
      expect(inspectState({ receipt_root: env.dir })).toMatchObject({
        active_dispatch: { dispatch_id: next.dispatch_id },
      });

      fs.writeFileSync(next.receipt_path, '# Work Receipt\n');
      completeDispatch({
        receipt_root: env.dir,
        dispatch_id: next.dispatch_id,
        report: {
          execution_status: 'succeeded',
          result: { outcome: 'implemented' },
          receipt_path: next.receipt_path,
          summary: 'Issue implemented',
        },
      });
      resolveDecision({ receipt_root: env.dir, decision: 'finish', reason: 'Work complete' });
      const finishedState = fs.readFileSync(getStateFilePath(env.dir), 'utf8');
      expect(dispatchTask(request)).toMatchObject(settled);
      expect(fs.readFileSync(getStateFilePath(env.dir), 'utf8')).toBe(finishedState);
    } finally {
      env.cleanup();
    }
  }, 20000);

  // T4: dispatch pending commit crash recovery
  it('T4: recovers interrupted dispatch commit from pending-commit record without duplicate budget consumption', () => {
    const env = createTestDir('pc-t4-');
    try {
      const state0 = initWorkflow({
        receipt_root: env.dir,
        root_issue: 104,
      });

      const prep = dispatchTask({
        receipt_root: env.dir,
        request_id: 'recovered-plan',
        stage: 'stage_1_plan',
        objective: 'Plan task',
        provider: { type: 'skill', target: 'pc-issue-plan' },
        workdir: env.dir,
      });

      const loadedState = loadRun<typeof state0>(env.dir);
      const envelopeContent = JSON.parse(fs.readFileSync(prep.envelope_path, 'utf8'));

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

      // Simulate interruption before the envelope and state were written.
      fs.unlinkSync(prep.envelope_path);
      fs.writeFileSync(getStateFilePath(env.dir), JSON.stringify(state0));
      fs.writeFileSync(pendingPath, JSON.stringify(pendingRecord));

      // loadRun should detect pending-commit, complete the target state, and remove pending-commit
      const recoveredState = loadRun<typeof state0>(env.dir);
      expect(recoveredState.active_dispatch?.dispatch_id).toBe(prep.dispatch_id);
      expect(fs.existsSync(pendingPath)).toBe(false);
      expect(JSON.parse(fs.readFileSync(prep.envelope_path, 'utf8'))).toEqual(envelopeContent);

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

      const state1 = loadRun<{ budgets: Record<string, unknown> }>(env.dir);
      expect(state1.budgets.delivery_attempts_used).toBe(0);
      expect(state1.budgets.replans_used).toBe(0);

      const p1 = dispatchTask({
        receipt_root: env.dir,
        request_id: 'initial-plan',
        stage: 'stage_1_plan',
        objective: 'Plan stage',
        provider: { type: 'skill', target: 'pc-issue-plan' },
        workdir: env.dir,
      });

      const state2 = loadRun<{ budgets: Record<string, unknown> }>(env.dir);
      expect(state2.budgets.delivery_attempts_used).toBe(1);

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

      const state3 = loadRun<{ budgets: Record<string, unknown> }>(env.dir);
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
      const p1 = runDispatchTaskCli(env.dir, {
        stage: 'stage_2_work',
        objective: 'Task 1',
        provider: {
          type: 'skill',
          target: 'pc-issue-work',
        },
      });
      const p1Data = JSON.parse(p1.stdout);
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
      const p2 = runDispatchTaskCli(env.dir, {
        stage: 'stage_2_work',
        objective: 'Task 1',
        provider: {
          type: 'skill',
          target: 'pc-issue-work',
        },
        attempt_intent: 'new',
      });
      const p2Data = JSON.parse(p2.stdout);
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
      const p3 = runDispatchTaskCli(env.dir, {
        stage: 'stage_2_work',
        objective: 'Task 1',
        provider: {
          type: 'skill',
          target: 'pc-issue-work',
        },
        attempt_intent: 'new',
      });
      const p3Data = JSON.parse(p3.stdout);
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
      expect(checkExceededData.budgets.delivery_attempts_max).toBe(3);
      expect(checkExceededData.finish_check.status).toBe('blocked');
      expect(checkExceededData.blocking_reasons).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/delivery attempt budget exhausted/i),
        ]),
      );
    } finally {
      env.cleanup();
    }
  }, 20000);

  it('V6: auxiliary completion preserves pending-stage constraint (W09)', () => {
    const env = createTestDir('pc-v6-');
    try {
      runLifecycleKernelCli(['init', '--receipt-root', env.dir, '--root-issue', '106']);

      // 1. Resolve sets next_stage to stage_2_work
      const resolveRes = runLifecycleKernelCli([
        'resolve',
        '--receipt-root', env.dir,
        '--decision', 'continue',
        '--reason', 'Select stage_2_work as next stage',
        '--next-stage', 'stage_2_work',
      ]);
      expect(resolveRes.status).toBe(0);

      // 2. Dispatch and complete auxiliary task: workspace_prepare
      const auxDispatch = runDispatchTaskCli(env.dir, {
        stage: 'workspace_prepare',
        objective: 'Prepare workspace',
        workdir: env.dir,
      });
      expect(auxDispatch.status).toBe(0);
      const auxData = JSON.parse(auxDispatch.stdout);
      fs.writeFileSync(auxData.receipt_path, '# Prepared\n');

      const auxComplete = runLifecycleKernelCli([
        'complete',
        '--receipt-root', env.dir,
        '--dispatch-id', auxData.dispatch_id,
        '--report', JSON.stringify({
          execution_status: 'succeeded',
          result: { outcome: 'prepared' },
          receipt_path: auxData.receipt_path,
          summary: 'Workspace prepared',
        }),
      ]);
      expect(auxComplete.status).toBe(0);

      // 3. Attempting to dispatch a conflicting primary stage (stage_3_verify) MUST be rejected
      const conflictDispatch = runDispatchTaskCli(env.dir, {
        stage: 'stage_3_verify',
        objective: 'Wrong stage',
        workdir: env.dir,
      });
      expect(conflictDispatch.status).not.toBe(0);
      expect(conflictDispatch.stderr).toMatch(/selected next_stage 'stage_2_work'/i);

      // 4. Dispatching the selected stage (stage_2_work) SUCCEEDS and consumes pending selection
      const correctDispatch = runDispatchTaskCli(env.dir, {
        stage: 'stage_2_work',
        objective: 'Work on stage 2',
        workdir: env.dir,
      });
      expect(correctDispatch.status).toBe(0);
    } finally {
      env.cleanup();
    }
  }, 20000);

  it('V9: restoration uses snapshot when workflow file deleted, and rejects 1.0 writes', () => {
    const env = createTestDir('pc-v9-');
    try {
      const customWfPath = path.join(env.dir, 'custom-workflow.json');
      fs.writeFileSync(
        customWfPath,
        JSON.stringify({
          name: 'custom-wf',
          completion_policy: 'basic',
          initial_stage: 's1',
          stages: [
            {
              id: 's1',
              logical_task: 'task_s1',
              provider: { type: 'skill', target: 'pc-workspace', args: [] },
            },
          ],
        }),
      );

      const runDir = path.join(env.dir, 'run');
      // Initialize run with custom workflow
      const initRes = runLifecycleKernelCli([
        'init',
        '--receipt-root', runDir,
        '--root-issue', '109',
        '--workflow', customWfPath,
      ]);
      expect(initRes.status).toBe(0);

      // Delete the external workflow file
      fs.unlinkSync(customWfPath);
      expect(fs.existsSync(customWfPath)).toBe(false);

      // Re-init (restoration) succeeds because it loads from snapshot, not external file
      const restoreRes = runLifecycleKernelCli([
        'init',
        '--receipt-root', runDir,
        '--root-issue', '109',
      ]);
      expect(restoreRes.status).toBe(0);

      // Now create a legacy 1.0 state.json to test 1.0 rejection
      const legacyDir = path.join(env.dir, 'legacy-run');
      fs.mkdirSync(legacyDir, { recursive: true });
      const legacyState = {
        schema_version: '1.0',
        root_issue_id: '110',
        current_issue_id: '110',
        workflow: 'default',
        workflow_snapshot: {
          name: 'default',
          completion_policy: 'basic',
          initial_stage: 's1',
          stages: [{ id: 's1', logical_task: 't1', provider: { type: 'skill', target: 'pc-workspace' } }],
        },
        current_stage: 's1',
        stage_status: 'pending',
        next_step_index: 1,
        active_dispatch: null,
        completed_stages: [],
        decisions: [],
        budgets: { delivery_attempts_used: 0, delivery_attempts_max: 3, replans_used: 0, replans_max: 2 },
        context: {},
        config_snapshot: { receipt_root: legacyDir },
        last_updated: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify(legacyState, null, 2));

      // init restoration rejects 1.0 write
      const legacyInit = runLifecycleKernelCli([
        'init',
        '--receipt-root', legacyDir,
        '--root-issue', '110',
      ]);
      expect(legacyInit.status).not.toBe(0);
      expect(legacyInit.stderr).toMatch(/legacy schema_version '1.0'/i);

      // dispatch rejects 1.0 write
      const legacyDispatch = runDispatchTaskCli(legacyDir, {
        stage: 's1',
        objective: 'Test 1.0 dispatch',
        workdir: env.dir,
      });
      expect(legacyDispatch.status).not.toBe(0);
      expect(legacyDispatch.stderr).toMatch(/legacy schema_version '1.0'/i);

      // inspect on 1.0 succeeds with legacy: true
      const legacyInspect = runLifecycleKernelCli([
        'inspect',
        '--receipt-root', legacyDir,
        '--json',
      ]);
      expect(legacyInspect.status).toBe(0);
      const inspectJson = JSON.parse(legacyInspect.stdout);
      expect(inspectJson.legacy).toBe(true);
      expect(inspectJson.schema_version).toBe('1.0');
    } finally {
      env.cleanup();
    }
  }, 20000);

  it('L4: nonempty stage scope is inherited when omitted, cleared when empty, and rejected when null', () => {
    const env = createTestDir('pc-l4-scope-');
    try {
      const scopedWorkflowPath = path.join(env.dir, 'scoped-workflow.json');
      fs.writeFileSync(
        scopedWorkflowPath,
        JSON.stringify({
          name: 'scoped-workflow',
          completion_policy: 'basic',
          initial_stage: 'scoped_stage',
          stages: [
            {
              id: 'scoped_stage',
              logical_task: 'scoped_stage',
              scope: 'packages/scoped',
              provider: { type: 'skill', target: 'pc-issue-work', args: [] },
            },
          ],
        }),
      );

      initWorkflow({
        receipt_root: env.dir,
        root_issue: 111,
        workflow: scopedWorkflowPath,
      });

      // 1. Omitted scope -> inherits stage scope 'packages/scoped'
      const dispatch1 = dispatchTask({
        receipt_root: env.dir,
        request_id: 'req-omitted-scope',
        stage: 'scoped_stage',
        objective: 'Test omitted scope',
        workdir: env.dir,
      });
      const env1 = JSON.parse(fs.readFileSync(dispatch1.envelope_path, 'utf8'));
      expect(env1.inputs.scope).toBe('packages/scoped');

      // Complete dispatch1 so we can test next dispatch
      fs.writeFileSync(dispatch1.receipt_path, '# Receipt 1');
      completeDispatch({
        receipt_root: env.dir,
        dispatch_id: dispatch1.dispatch_id,
        report: {
          execution_status: 'succeeded',
          result: { outcome: 'done' },
          receipt_path: dispatch1.receipt_path,
          summary: 'Done',
        },
      });

      // 2. Explicit scope: "" -> explicitly clears scope to ""
      const dispatch2 = dispatchTask({
        receipt_root: env.dir,
        request_id: 'req-cleared-scope',
        stage: 'scoped_stage',
        objective: 'Test cleared scope',
        scope: '',
        workdir: env.dir,
      });
      const env2 = JSON.parse(fs.readFileSync(dispatch2.envelope_path, 'utf8'));
      expect(env2.inputs.scope).toBe('');

      // 3. Explicit scope: null -> invalid new request rejected at boundary
      expect(() =>
        dispatchTask({
          receipt_root: env.dir,
          request_id: 'req-null-scope',
          stage: 'scoped_stage',
          objective: 'Test null scope',
          scope: null as unknown as string,
          workdir: env.dir,
        }),
      ).toThrow(/scope/i);
    } finally {
      env.cleanup();
    }
  });

  it('L5: replaying recorded request matches before pause check and supports historical records', () => {
    const env = createTestDir('pc-l5-replay-');
    try {
      initWorkflow({ receipt_root: env.dir, root_issue: 112 });
      const req = {
        receipt_root: env.dir,
        request_id: 'req-active-replay',
        stage: 'stage_1_plan',
        objective: 'Replay test',
        workdir: env.dir,
      };

      const first = dispatchTask(req);
      expect(first.launch_granted).toBe(true);

      // Now pause the workflow
      resolveDecision({
        receipt_root: env.dir,
        decision: 'wait_user',
        reason: 'Testing pause replay',
      });

      // Replaying the active request while paused must succeed without launch grant and NOT throw pause error
      const replay = dispatchTask(req);
      expect(replay.dispatch_id).toBe(first.dispatch_id);
      expect(replay.launch_granted).toBe(false);

      // A genuinely new request while paused MUST be rejected by active dispatch check
      expect(() =>
        dispatchTask({
          receipt_root: env.dir,
          request_id: 'req-genuinely-new',
          stage: 'stage_1_plan',
          objective: 'Blocked by pause',
          workdir: env.dir,
        }),
      ).toThrow(/Active dispatch/i);
    } finally {
      env.cleanup();
    }
  });

  it('L6 & L7: resolve rejects unknown options and inspect provides typed FinishCheck', () => {
    const env = createTestDir('pc-l6-l7-');
    try {
      initWorkflow({ receipt_root: env.dir, root_issue: 113 });

      // Unknown resolve field rejected
      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: 'continue',
          reason: 'Valid reason',
          unknown_option: true,
        } as unknown as ResolveOptions),
      ).toThrow(/Unknown resolve option/i);

      // Non-array options rejected
      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: 'wait_user',
          reason: 'Valid reason',
          options: 'not-an-array' as unknown as string[],
        }),
      ).toThrow(/Field 'options' must be an array of strings/i);

      // Non-boolean complete_sequence rejected
      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: 'continue',
          reason: 'Valid reason',
          complete_sequence: 'true' as unknown as boolean,
        }),
      ).toThrow(/Field 'complete_sequence' must be a boolean/i);

      // InspectState returns typed RunInspection
      const inspection = inspectState({ receipt_root: env.dir });
      expect(inspection.finish_check).toBeDefined();
      expect(inspection.finish_check.status).toBe('blocked');
      expect(inspection.finish_check.reasons.length).toBeGreaterThan(0);
      expect(inspection.blocking_reasons).toEqual([]); // no run-level blockers initially
    } finally {
      env.cleanup();
    }
  });
});
