/**
 * Tier 4: Real-World Scenarios
 *
 * Simulates complete end-to-end task dispatch lifecycles:
 * - Multi-stage pipeline execution (workspace_prepare -> issue_work -> issue_verify)
 * - Input envelope generation, validation, kernel/subagent execution, receipt writing,
 *   compact report verification, and state transitions.
 * - Fault tolerance and isolation when execution fails.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CompactReceiptReport,
  createTestDir,
  runEnvelopeCli,
  runPython,
  runStateMachineCli,
  type TaskInputEnvelope,
} from './test-helpers.js';

describe('Tier 4: Real-World Scenarios', () => {
  let testEnv: { dir: string; cleanup: () => void };

  beforeEach(() => {
    testEnv = createTestDir('tier4-scenarios-');
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  /**
   * Helper creating a realistic workspace kernel script that acts as a script provider.
   */
  function createWorkspaceKernelScript(): string {
    const scriptPath = path.join(testEnv.dir, 'workspace_kernel.py');
    const content = `#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import sys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-envelope", required=True)
    args = parser.parse_args()

    with open(args.input_envelope, "r", encoding="utf-8") as f:
        envelope = json.load(f)

    # Perform workspace preparation logic
    workdir = Path(envelope["environment"]["working_directory"]).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    branch = envelope["environment"].get("branch") or "issue-default"
    commit = envelope["environment"].get("commit") or "mocksha123456789012345678901234567890"

    receipt_path = Path(envelope["contract"]["receipt_path"]).resolve()
    receipt_path.parent.mkdir(parents=True, exist_ok=True)

    with open(receipt_path, "w", encoding="utf-8") as rf:
        rf.write(f"# Workspace Preparation Receipt\\n\\n")
        rf.write(f"- Worktree: {workdir}\\n")
        rf.write(f"- Branch: {branch}\\n")
        rf.write(f"- Commit: {commit}\\n")
        rf.write(f"- Status: ready\\n")

    report = {
        "execution_status": "succeeded",
        "result": {
            "worktree": str(workdir),
            "branch": branch,
            "commit": commit,
            "outcome": "prepared"
        },
        "receipt_path": str(receipt_path),
        "summary": f"Prepared worktree {workdir} for branch {branch}."
    }
    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()
`;
    fs.writeFileSync(scriptPath, content, 'utf-8');
    return scriptPath;
  }

  it('S4.1: complete end-to-end task dispatch lifecycle across 3 stages', () => {
    const issueId = '42';
    const rootDir = testEnv.dir;
    const worktreeDir = path.join(rootDir, 'worktree-issue-42');
    const stateFile = path.join(rootDir, 'state.json');

    // ==========================================
    // Phase 0: Initialize Orchestrator Workflow
    // ==========================================
    const initRes = runStateMachineCli([
      'init',
      '--receipt-root', rootDir,
      '--root-issue', issueId,
      '--workflow', 'default',
      '--initial-stage', 'workspace_prepare',
    ]);
    expect(initRes.status).toBe(0);

    // ==========================================
    // Phase 1: Workspace Preparation (Script Provider)
    // ==========================================
    const kernelScript = createWorkspaceKernelScript();
    const step1EnvelopePath = path.join(rootDir, 'step-1-input.json');
    const step1ReceiptPath = path.join(rootDir, 'step-1-receipt.md');

    const env1Res = runEnvelopeCli([
      'create',
      '--from-state', stateFile,
      '--output', step1EnvelopePath,
      '--step', '1',
      '--provider-type', 'script',
      '--provider-target', kernelScript,
      '--workdir', worktreeDir,
      '--branch', `issue-${issueId}`,
      '--commit', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      '--objective', 'Prepare isolated worktree environment',
      '--receipt-path', step1ReceiptPath,
    ]);
    expect(env1Res.status).toBe(0);

    // Validate envelope file before execution
    const val1 = runEnvelopeCli(['validate', step1EnvelopePath]);
    expect(val1.status).toBe(0);

    // Execute script kernel
    const exec1 = runPython(kernelScript, ['--input-envelope', step1EnvelopePath]);
    expect(exec1.status).toBe(0);

    // Verify compact report and receipt file
    const report1: CompactReceiptReport = JSON.parse(exec1.stdout);
    expect(report1.execution_status).toBe('succeeded');
    expect(report1.result.outcome).toBe('prepared');
    expect(fs.existsSync(step1ReceiptPath)).toBe(true);

    // Transition state machine with step 1 receipt
    runStateMachineCli([
      'transition',
      '--receipt-root', rootDir,
      '--stage', 'issue_work',
      '--status', 'succeeded',
      '--receipt', step1ReceiptPath,
      '--set', `worktree=${worktreeDir}`,
      '--set', `branch=issue-${issueId}`,
      '--set', `commit=${report1.result.commit}`,
    ]);

    // ==========================================
    // Phase 2: Implementation Stage (Skill Provider)
    // ==========================================
    const step2EnvelopePath = path.join(rootDir, 'step-2-input.json');
    const step2ReceiptPath = path.join(rootDir, 'step-2-receipt.md');

    const env2Res = runEnvelopeCli([
      'create',
      '--from-state', stateFile,
      '--output', step2EnvelopePath,
      '--step', '2',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-work',
      '--objective', 'Implement features for issue 42',
      '--criteria', 'All unit tests pass',
      '--criteria', 'Linting passes',
      '--receipt-path', step2ReceiptPath,
    ]);
    expect(env2Res.status).toBe(0);

    const env2: TaskInputEnvelope = JSON.parse(fs.readFileSync(step2EnvelopePath, 'utf-8'));
    expect(env2.inputs.predecessor_receipts).toContain(step1ReceiptPath);
    expect(env2.environment.working_directory).toBe(path.resolve(worktreeDir));
    expect(env2.provider.type).toBe('skill');
    expect(env2.provider.target).toBe('pc-issue-work');

    // Simulate Subagent execution writing receipt and compact report
    fs.writeFileSync(
      step2ReceiptPath,
      '# Implementation Receipt\n\n- Tests: 10 passed\n- Commit: b2c3d4e5\n',
    );
    const report2: CompactReceiptReport = {
      execution_status: 'succeeded',
      result: {
        outcome: 'implemented',
        commit: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
      },
      receipt_path: step2ReceiptPath,
      summary: 'Implemented feature and verified test suite.',
    };

    // Transition state machine
    runStateMachineCli([
      'transition',
      '--receipt-root', rootDir,
      '--stage', 'issue_verify',
      '--status', 'succeeded',
      '--receipt', step2ReceiptPath,
      '--set', `commit=${report2.result.commit}`,
    ]);

    // ==========================================
    // Phase 3: Verification Stage (Skill Provider)
    // ==========================================
    const step3EnvelopePath = path.join(rootDir, 'step-3-input.json');
    const step3ReceiptPath = path.join(rootDir, 'step-3-receipt.md');

    const env3Res = runEnvelopeCli([
      'create',
      '--from-state', stateFile,
      '--output', step3EnvelopePath,
      '--step', '3',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-verify',
      '--objective', 'Run integrated acceptance verification',
      '--receipt-path', step3ReceiptPath,
    ]);
    expect(env3Res.status).toBe(0);

    const env3: TaskInputEnvelope = JSON.parse(fs.readFileSync(step3EnvelopePath, 'utf-8'));
    expect(env3.inputs.predecessor_receipts).toContain(step2ReceiptPath);

    fs.writeFileSync(step3ReceiptPath, '# Integrated Acceptance Receipt\nOutcome: verified\n');

    runStateMachineCli([
      'transition',
      '--receipt-root', rootDir,
      '--stage', 'completed',
      '--status', 'succeeded',
      '--receipt', step3ReceiptPath,
    ]);

    // Inspect final state
    const stateShow = runStateMachineCli(['show', '--receipt-root', rootDir, '--json']);
    const finalState = JSON.parse(stateShow.stdout);
    expect(finalState.current_stage).toBe('completed');
    expect(finalState.stage_status).toBe('succeeded');
    expect(finalState.completed_stages.length).toBe(3);
  }, 20000);

  it('S4.2: handles script execution failure with report and budget increment', () => {
    // A script kernel that encounters a failure condition
    const failingScriptPath = path.join(testEnv.dir, 'failing_kernel.py');
    const content = `#!/usr/bin/env python3
import json
import sys

report = {
    "execution_status": "failed",
    "result": {"error": "Compilation failed due to syntax error"},
    "receipt_path": "/tmp/fail-receipt.md",
    "summary": "Build error during compilation."
}
print(json.dumps(report))
sys.exit(1)
`;
    fs.writeFileSync(failingScriptPath, content, 'utf-8');

    runStateMachineCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '99',
      '--initial-stage', 'stage_2_work',
    ]);

    const execResult = runPython(failingScriptPath, []);
    expect(execResult.status).toBe(1);

    const report: CompactReceiptReport = JSON.parse(execResult.stdout);
    expect(report.execution_status).toBe('failed');
    expect(report.summary).toContain('Build error');

    // Orchestrator logs failure and increments delivery attempt
    const trans = runStateMachineCli([
      'transition',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_2_work',
      '--status', 'failed',
      '--incr-budget', 'delivery_attempts_used',
    ]);
    expect(trans.status).toBe(0);

    const stateShow = runStateMachineCli(['show', '--receipt-root', testEnv.dir, '--json']);
    const stateObj = JSON.parse(stateShow.stdout);
    expect(stateObj.budgets.delivery_attempts_used).toBe(1);
    expect(stateObj.stage_status).toBe('failed');
  });

  it('S4.3: guarantees state isolation when envelope generation fails', () => {
    runStateMachineCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '100',
      '--initial-stage', 'stage_1_plan',
    ]);

    const stateFile = path.join(testEnv.dir, 'state.json');
    const stateBefore = fs.readFileSync(stateFile, 'utf-8');

    // Attempt invalid envelope creation (missing required objective)
    const invalidEnvPath = path.join(testEnv.dir, 'invalid-env.json');
    const result = runEnvelopeCli([
      'create',
      '--from-state', stateFile,
      '--output', invalidEnvPath,
      '--step', '1',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-plan',
      '--receipt-path', path.join(testEnv.dir, 'receipt.md'),
      // Omit --objective
    ]);

    expect(result.status).not.toBe(0);
    // Envelope file should not have been created
    expect(fs.existsSync(invalidEnvPath)).toBe(false);

    // State file must remain completely unaltered
    const stateAfter = fs.readFileSync(stateFile, 'utf-8');
    expect(stateAfter).toBe(stateBefore);
  });
});
