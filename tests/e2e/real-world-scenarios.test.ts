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
  runLifecycleKernelCli,
  runPrepareTaskCli,
  runPython,
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

    // ==========================================
    // Phase 0: Initialize Orchestrator Workflow
    // ==========================================
    const initRes = runLifecycleKernelCli([
      'init',
      '--receipt-root', rootDir,
      '--root-issue', issueId,
      '--workflow', 'default',
    ]);
    expect(initRes.status).toBe(0);

    // ==========================================
    // Phase 1: Workspace Preparation (Script Provider)
    // ==========================================
    const kernelScript = createWorkspaceKernelScript();
    const env1Res = runPrepareTaskCli(rootDir, {
      stage: 'workspace_prepare',
      objective: 'Prepare isolated worktree environment',
      provider: {
        type: 'script',
        target: kernelScript,
      },
      workdir: worktreeDir,
      branch: `issue-${issueId}`,
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    });
    expect(env1Res.status).toBe(0);
    const p1 = JSON.parse(env1Res.stdout);
    const step1EnvelopePath = p1.envelope_path;
    const step1ReceiptPath = p1.receipt_path;

    // Validate envelope file before execution
    const val1 = runEnvelopeCli(['validate', step1EnvelopePath]);
    expect(val1.status).toBe(0);

    // Handoff step 1
    runLifecycleKernelCli(['handoff', '--receipt-root', rootDir]);

    // Execute script kernel
    const exec1 = runPython(kernelScript, ['--input-envelope', step1EnvelopePath]);
    expect(exec1.status).toBe(0);

    // Verify compact report and receipt file
    const report1: CompactReceiptReport = JSON.parse(exec1.stdout);
    expect(report1.execution_status).toBe('succeeded');
    expect(report1.result.outcome).toBe('prepared');
    expect(fs.existsSync(step1ReceiptPath)).toBe(true);

    // Complete step 1
    const comp1 = runLifecycleKernelCli([
      'complete',
      '--receipt-root', rootDir,
      '--report', JSON.stringify(report1),
    ]);
    expect(comp1.status).toBe(0);

    // ==========================================
    // Phase 2: Implementation Stage (Skill Provider)
    // ==========================================
    const env2Res = runPrepareTaskCli(rootDir, {
      stage: 'issue_work',
      objective: 'Implement features for issue 42',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      workdir: worktreeDir,
      acceptance_criteria: ['All unit tests pass', 'Linting passes'],
    });
    expect(env2Res.status).toBe(0);
    const p2 = JSON.parse(env2Res.stdout);
    const step2EnvelopePath = p2.envelope_path;
    const step2ReceiptPath = p2.receipt_path;

    const env2: TaskInputEnvelope = JSON.parse(fs.readFileSync(step2EnvelopePath, 'utf-8'));
    expect(env2.inputs.predecessor_receipts).toContain(step1ReceiptPath);
    expect(env2.environment.working_directory).toBe(path.resolve(worktreeDir));
    expect(env2.provider.type).toBe('skill');
    expect(env2.provider.target).toBe('pc-issue-work');

    runLifecycleKernelCli(['handoff', '--receipt-root', rootDir]);

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

    const comp2 = runLifecycleKernelCli([
      'complete',
      '--receipt-root', rootDir,
      '--report', JSON.stringify(report2),
    ]);
    expect(comp2.status).toBe(0);

    // ==========================================
    // Phase 3: Verification Stage (Skill Provider)
    // ==========================================
    const env3Res = runPrepareTaskCli(rootDir, {
      stage: 'issue_verify',
      objective: 'Run integrated acceptance verification',
      provider: {
        type: 'skill',
        target: 'pc-issue-verify',
      },
      workdir: worktreeDir,
    });
    expect(env3Res.status).toBe(0);
    const p3 = JSON.parse(env3Res.stdout);
    const step3EnvelopePath = p3.envelope_path;
    const step3ReceiptPath = p3.receipt_path;

    const env3: TaskInputEnvelope = JSON.parse(fs.readFileSync(step3EnvelopePath, 'utf-8'));
    expect(env3.inputs.predecessor_receipts).toContain(step2ReceiptPath);

    runLifecycleKernelCli(['handoff', '--receipt-root', rootDir]);

    fs.writeFileSync(step3ReceiptPath, '# Integrated Acceptance Receipt\nOutcome: verified\n');

    const report3: CompactReceiptReport = {
      execution_status: 'succeeded',
      result: { outcome: 'verified' },
      receipt_path: step3ReceiptPath,
      summary: 'Verification succeeded.',
    };

    const comp3 = runLifecycleKernelCli([
      'complete',
      '--receipt-root', rootDir,
      '--report', JSON.stringify(report3),
    ]);
    expect(comp3.status).toBe(0);

    const resolveRes = runLifecycleKernelCli([
      'resolve',
      '--receipt-root', rootDir,
      '--decision', 'finish',
      '--reason', 'All stages completed successfully',
    ]);
    expect(resolveRes.status).toBe(0);

    // Inspect final state
    const stateShow = runLifecycleKernelCli(['inspect', '--receipt-root', rootDir, '--json']);
    const finalState = JSON.parse(stateShow.stdout);
    expect(finalState.current_stage).toBe('completed');
    expect(finalState.stage_status).toBe('succeeded');
    expect(finalState.completed_stages_count).toBe(3);
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

    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '99',
    ]);

    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_work',
      objective: 'Run failing kernel script',
      provider: {
        type: 'script',
        target: failingScriptPath,
      },
      workdir: testEnv.dir,
    });
    const prepData = JSON.parse(prepRes.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir]);

    const execResult = runPython(failingScriptPath, []);
    expect(execResult.status).toBe(1);

    const report: CompactReceiptReport = JSON.parse(execResult.stdout);
    expect(report.execution_status).toBe('failed');
    expect(report.summary).toContain('Build error');

    // Complete with failed report and receipt
    fs.writeFileSync(prepData.receipt_path, '# Failure Receipt\nError during build');
    const compRes = runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--report', JSON.stringify({
        execution_status: 'failed',
        result: report.result,
        receipt_path: prepData.receipt_path,
        summary: report.summary,
      }),
    ]);
    expect(compRes.status).toBe(0);

    const stateShow = runLifecycleKernelCli(['inspect', '--receipt-root', testEnv.dir, '--json']);
    const stateObj = JSON.parse(stateShow.stdout);
    expect(stateObj.budgets.delivery_attempts_used).toBe(1);
    expect(stateObj.stage_status).toBe('failed');
  });

  it('S4.3: guarantees state isolation when envelope generation fails', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '100',
    ]);

    const stateFile = path.join(testEnv.dir, 'state.json');
    const stateBefore = fs.readFileSync(stateFile, 'utf-8');

    // Attempt invalid prepare (missing required objective)
    const result = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_1_plan',
      provider: {
        type: 'skill',
        target: 'pc-issue-plan',
      },
    });

    expect(result.status).not.toBe(0);
    // Envelope 01-input.json should not exist
    expect(fs.existsSync(path.join(testEnv.dir, '01-input.json'))).toBe(false);

    // State file must remain completely unaltered
    const stateAfter = fs.readFileSync(stateFile, 'utf-8');
    expect(stateAfter).toBe(stateBefore);
  });
});
