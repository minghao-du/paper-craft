/**
 * @fileoverview Demonstration of real agy dispatch and result collection round trip.
 * Run separately from routine tests: npx tsx scripts/demo-real-agy-roundtrip.ts
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkflowEngine } from '../packages/core/src/workflow/engine.js';
import { AgyExecutor } from '../packages/core/src/workflow/executor.js';
import { RepositoryManager } from '../packages/core/src/workflow/repository.js';
import type { ProviderChecker } from '../packages/core/src/workflow/types.js';

async function main() {
  console.log('=== Real Agy Dispatch & Collect Round Trip Demonstration ===\n');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-agy-demo-'));
  console.log(`1. Workspace directory: ${tmpDir}`);

  // 1. Check real agy availability
  const agyExecutor = new AgyExecutor({ command: 'agy' });
  const checkRes = await agyExecutor.check();
  console.log(`2. agy check result: available=${checkRes.available} ${checkRes.error ? `error=${checkRes.error}` : ''}`);

  if (!checkRes.available) {
    console.error('agy is not available on this machine. Cannot run real agy demo.');
    process.exit(1);
  }

  // 2. Initialize Engine with real AgyExecutor
  const repositoryManager = new RepositoryManager({
    issueInspector: async (_repo, issue) => ({
      exists: true,
      open: true,
      title: `Demonstration Issue #${issue}`,
    }),
  });

  const mockProviderChecker: ProviderChecker = {
    check: async (provider) => {
      if (provider === 'agy') return agyExecutor.check();
      return { available: false, error: `Unsupported provider: ${provider}` };
    },
  };

  const engine = new WorkflowEngine({
    cwd: tmpDir,
    executor: agyExecutor,
    repositoryManager,
    providerChecker: mockProviderChecker,
  });

  console.log('3. Initializing workflow configuration...');
  await engine.init({ repository: 'minghao-du/paper-craft', provider: 'agy' });

  console.log('4. Starting workflow run for Issue #3...');
  const run = await engine.start({
    issue: 3,
    requirements: 'Demonstrate real agy dispatch and result round trip.',
  });
  console.log(`   Created Run: ${run.run_id}`);
  console.log(`   Worktree Path: ${run.worktree_path}`);

  console.log('5. Obtaining scheduling context for orchestrator...');
  const schedContext = await engine.getSchedulingContext(run.run_id);
  console.log(`   Current Step: ${schedContext.currentStep}`);
  console.log(`   Assigned Role: ${schedContext.stepDefinition.role}`);
  console.log(`   Designated Skill: ${schedContext.roleContract.skill}`);
  console.log(`   Permitted Outcomes: [${schedContext.roleContract.permitted_outcomes.join(', ')}]`);
  console.log(`   Required Artifacts: [${(schedContext.roleContract.required_artifacts ?? []).join(', ')}]`);

  console.log('6. Dispatching worker role task via real agy executor...');
  const dispatchRes = await engine.dispatch(
    run.run_id,
    'Please implement and verify real agy dispatch demonstration.',
  );
  console.log(`   Dispatched Task ID: ${dispatchRes.taskId}`);
  console.log(`   Provider Handle ID: ${dispatchRes.handle.id}`);

  console.log('7. Inspecting running process status...');
  const initialInspection = await agyExecutor.inspect(dispatchRes.taskId);
  console.log(`   Execution status: ${initialInspection.status}`);

  const midStatus = await engine.status(run.run_id);
  console.log(`   Engine status: ${midStatus.status}`);
  console.log(`   Active task execution status: ${midStatus.active_task?.execution_status}`);
  console.log(`   Active task business outcome: ${midStatus.active_task?.business_outcome ?? 'none (in progress)'}`);

  console.log('8. Submitting task result via submitResult contract...');
  const submitRes = await engine.submitResult(run.run_id, dispatchRes.taskId, {
    outcome: 'completed',
    summary: 'Real agy task dispatched, executed, and result successfully collected.',
    artifacts: {
      diff: 'diff --git a/demo.txt b/demo.txt\n+roundtrip complete',
      test_results: 'Real agy round trip verified: 1 passed',
    },
  });

  console.log(`   Submission acknowledged: ${submitRes.acknowledged}`);
  console.log(`   Submitted outcome: ${submitRes.outcome}`);
  console.log(`   Execution termination verified: ${submitRes.executionTerminated}`);

  console.log('9. Checking final engine status and stopping milestone...');
  const finalStatus = await engine.status(run.run_id);
  console.log(`   Final Run status: ${finalStatus.status}`);
  console.log(`   Summary: ${finalStatus.summary}`);
  console.log(`   Collected outcome: ${finalStatus.active_task?.business_outcome}`);
  console.log(`   Role execution stopped: ${finalStatus.active_task?.stopped}`);

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('\n=== Demonstration Completed Successfully! ===');
}

main().catch((err) => {
  console.error('Demonstration failed:', err);
  process.exit(1);
});
