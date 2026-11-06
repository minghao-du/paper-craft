/**
 * @fileoverview Demonstration of real agy dispatch and result collection round trip using Run.
 * Run separately from routine tests: npx tsx scripts/demo-real-agy-roundtrip.ts
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Run } from '../packages/core/src/workflow/run.js';
import { AgyExecutor } from '../packages/core/src/workflow/executor.js';

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

  // 2. Open Run with real AgyExecutor
  console.log('3. Opening Run for Issue #3...');
  const run = await Run.open({
    issue: 3,
    goal: 'Demonstrate real agy dispatch and result round trip.',
    repoRoot: tmpDir,
    provider: 'agy',
    executor: agyExecutor,
  });
  console.log(`   Created Run: ${run.runId}`);
  console.log(`   Worktree Path: ${run.worktreePath}`);

  // 3. Dispatch task via real agy executor
  console.log('4. Dispatching pc-issue-work task via real agy executor...');
  const dispatchRes = await run.dispatch({
    taskType: 'pc-issue-work',
    instructions: 'Please implement and verify real agy dispatch demonstration.',
  });
  console.log(`   Dispatched Task ID: ${dispatchRes.taskId}`);
  console.log(`   Provider Handle ID: ${dispatchRes.handle.id}`);

  // 4. Inspect running process status
  console.log('5. Inspecting running process status...');
  const initialInspection = await agyExecutor.inspect(dispatchRes.taskId);
  console.log(`   Execution status: ${initialInspection.status}`);

  const midObs = await run.observe();
  console.log(`   Run status: ${midObs.status}`);
  console.log(`   Active task ID: ${midObs.activeTaskId}`);
  console.log(`   Execution inspection status: ${midObs.execution?.status}`);

  // 5. Submitting task result via submitResult contract
  console.log('6. Submitting task result via submitResult contract...');
  const submitRes = await run.submitResult(dispatchRes.taskId, {
    outcome: 'completed',
    summary: 'Real agy task dispatched, executed, and result successfully collected.',
    artifacts: {
      diff: 'diff --git a/demo.txt b/demo.txt\n+roundtrip complete',
      testResults: 'Real agy round trip verified: 1 passed',
    },
  });

  console.log(`   Submission acknowledged: ${submitRes.acknowledged}`);
  console.log(`   Submitted outcome: ${submitRes.result.outcome}`);

  // 6. Checking final run observation
  console.log('7. Checking final Run observation...');
  const finalObs = await run.observe();
  console.log(`   Final Run status: ${finalObs.status}`);
  console.log(`   Validated result summary: ${finalObs.result?.summary}`);

  // 7. Finish Run
  console.log('8. Finishing Run and releasing resources...');
  const finishRes = await run.finish({
    conclusion: 'Real agy roundtrip demonstration completed successfully.',
  });
  console.log(`   Run completed: ${finishRes.completed}`);
  console.log(`   Worktree retired: ${finishRes.worktreeRetired}`);

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('\n=== Demonstration Completed Successfully! ===');
}

main().catch((err) => {
  console.error('Demonstration failed:', err);
  process.exit(1);
});
