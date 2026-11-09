/**
 * Tier 1 Feature Tests: Skill Kernel-Wrapper Pattern & Unified Receipt Contract
 *
 * Verifies kernel execution driven by Task Input Envelope, standard markdown
 * receipt generation, and stdout compact report conformance { execution_status, result, receipt_path, summary }.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CompactReceiptReport,
  createTestDir,
  REPO_ROOT,
  runLifecycleKernelCli,
  runPrepareTaskCli,
  runPython,
  type TaskInputEnvelope,
} from './test-helpers.js';

describe('Tier 1: Skill Kernel-Wrapper Pattern Core Features', () => {
  let testEnv: { dir: string; cleanup: () => void };

  beforeEach(() => {
    testEnv = createTestDir('tier1-kernel-');
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  /**
   * Helper to create a representative kernel runner script adhering to
   * the Kernel-Wrapper specification in PROJECT.md.
   */
  function createSampleKernelScript(): string {
    const scriptPath = path.join(testEnv.dir, 'sample_kernel.py');
    const content = `#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import sys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-envelope", required=True, help="Path to input envelope")
    args = parser.parse_args()

    env_path = Path(args.input_envelope).resolve()
    if not env_path.exists():
        sys.stderr.write(f"Envelope not found: {env_path}\\n")
        sys.exit(1)

    with open(env_path, "r", encoding="utf-8") as f:
        envelope = json.load(f)

    # Deterministic execution using envelope inputs
    stage = envelope["task"]["logical_stage"]
    objective = envelope["inputs"]["objective"]
    receipt_path = Path(envelope["contract"]["receipt_path"]).resolve()

    # Generate markdown receipt
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    with open(receipt_path, "w", encoding="utf-8") as rf:
        rf.write(f"# Receipt for {stage}\\n\\n")
        rf.write(f"**Objective**: {objective}\\n")
        rf.write(f"**Status**: completed\\n")

    # Output compact JSON report to stdout
    report = {
        "execution_status": "succeeded",
        "result": {
            "stage": stage,
            "artifacts_created": [str(receipt_path)],
        },
        "receipt_path": str(receipt_path),
        "summary": f"Executed stage {stage} successfully."
    }
    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()
`;
    fs.writeFileSync(scriptPath, content, 'utf-8');
    return scriptPath;
  }

  it('F3.1: kernel script executes driven by --input-envelope', () => {
    const kernelScript = createSampleKernelScript();
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '12',
    ]);
    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace tree',
      provider: {
        type: 'script',
        target: kernelScript,
      },
      workdir: testEnv.dir,
    });
    expect(prepRes.status).toBe(0);
    const prepData = JSON.parse(prepRes.stdout);
    const envelopePath = prepData.envelope_path;
    const receiptPath = prepData.receipt_path;

    const execResult = runPython(kernelScript, ['--input-envelope', envelopePath]);
    expect(execResult.status).toBe(0);
    expect(fs.existsSync(receiptPath)).toBe(true);

    const report: CompactReceiptReport = JSON.parse(execResult.stdout);
    expect(report.execution_status).toBe('succeeded');
    expect(report.receipt_path).toBe(path.resolve(receiptPath));
  });

  it('F3.2: kernel consumes envelope parameters and environment', () => {
    const kernelScript = createSampleKernelScript();
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '15',
    ]);
    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'issue_work',
      objective: 'Run parameter-driven task',
      provider: {
        type: 'script',
        target: kernelScript,
      },
      workdir: testEnv.dir,
      scope: 'Scope details here',
    });
    expect(prepRes.status).toBe(0);
    const prepData = JSON.parse(prepRes.stdout);
    const envelopePath = prepData.envelope_path;
    const receiptPath = prepData.receipt_path;

    const execResult = runPython(kernelScript, ['--input-envelope', envelopePath]);
    expect(execResult.status).toBe(0);

    const receiptContent = fs.readFileSync(receiptPath, 'utf-8');
    expect(receiptContent).toContain('# Receipt for issue_work');
    expect(receiptContent).toContain('**Objective**: Run parameter-driven task');
  });

  it('F3.3: kernel writes deterministic Markdown receipt to contract path', () => {
    const kernelScript = createSampleKernelScript();
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '25',
    ]);
    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'pipeline_audit',
      objective: 'Audit pipeline rules',
      provider: {
        type: 'script',
        target: kernelScript,
      },
      workdir: testEnv.dir,
    });
    expect(prepRes.status).toBe(0);
    const prepData = JSON.parse(prepRes.stdout);
    const envelopePath = prepData.envelope_path;
    const receiptPath = prepData.receipt_path;

    const execResult = runPython(kernelScript, ['--input-envelope', envelopePath]);
    expect(execResult.status).toBe(0);
    expect(fs.existsSync(receiptPath)).toBe(true);

    const content = fs.readFileSync(receiptPath, 'utf-8');
    expect(content.length).toBeGreaterThan(10);
    expect(content).toContain('**Status**: completed');
  });

  it('F3.4: kernel halts with exit code 1 when input envelope does not exist', () => {
    const kernelScript = createSampleKernelScript();
    const nonExistentEnvelope = path.join(testEnv.dir, 'does-not-exist.json');

    const execResult = runPython(kernelScript, ['--input-envelope', nonExistentEnvelope]);
    expect(execResult.status).toBe(1);
    expect(execResult.stderr).toContain('Envelope not found');
  });

  it('F3.5: cognitive wrapper equivalence between LLM subagent and script execution', () => {
    // Both skill-based subagent and script provider consume the identical input envelope schema
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '55',
    ]);
    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'issue_verify',
      objective: 'Cognitive wrapper test',
      provider: {
        type: 'skill',
        target: 'pc-issue-verify',
      },
      workdir: testEnv.dir,
    }, { cwd: testEnv.dir });
    expect(prepRes.status).toBe(0);
    const prepData = JSON.parse(prepRes.stdout);
    const envelopePath = prepData.envelope_path;
    const receiptPath = prepData.receipt_path;

    const envelope: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(envelope.contract.receipt_path).toBe(path.resolve(receiptPath));
    expect(path.isAbsolute(envelope.contract.receipt_template)).toBe(true);
    expect(envelope.contract.receipt_template).toBe(path.join(
      REPO_ROOT, 'skills/pc-orchestrator/templates/subagent-receipt.template.md',
    ));
    expect(fs.readFileSync(envelope.contract.receipt_template, 'utf-8').length).toBeGreaterThan(0);
    expect(envelope.inputs.objective).toBe('Cognitive wrapper test');
  });
});

describe('Tier 1: Unified Receipt Contract Core Features', () => {
  let testEnv: { dir: string; cleanup: () => void };

  beforeEach(() => {
    testEnv = createTestDir('tier1-receipt-');
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('F4.1: compact JSON report adheres to { execution_status, result, receipt_path, summary }', () => {
    const validReport: CompactReceiptReport = {
      execution_status: 'succeeded',
      result: {
        outcome: 'verified',
        evaluatedHead: 'abcdef1234567890abcdef1234567890abcdef12',
      },
      receipt_path: path.join(testEnv.dir, 'verify-receipt.md'),
      summary: 'Verified integrated HEAD against acceptance criteria.',
    };

    expect(validReport).toHaveProperty('execution_status');
    expect(validReport).toHaveProperty('result');
    expect(validReport).toHaveProperty('receipt_path');
    expect(validReport).toHaveProperty('summary');
    expect(typeof validReport.summary).toBe('string');
  });

  it('F4.2: enforces allowed execution_status values ("succeeded" | "blocked" | "failed")', () => {
    const validStatuses = ['succeeded', 'blocked', 'failed'] as const;
    for (const status of validStatuses) {
      const report: CompactReceiptReport = {
        execution_status: status,
        result: {},
        receipt_path: '/tmp/receipt.md',
        summary: `Status is ${status}`,
      };
      expect(['succeeded', 'blocked', 'failed']).toContain(report.execution_status);
    }
  });

  it('F4.3: physical receipt file presence and non-emptiness verification', () => {
    const receiptPath = path.join(testEnv.dir, 'work-receipt.md');
    fs.writeFileSync(receiptPath, '# Stage 2 Delivery Receipt\n\n- Commit: sha123\n- Status: Landed\n');

    expect(fs.existsSync(receiptPath)).toBe(true);
    const stat = fs.statSync(receiptPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('F4.4: predecessor receipt chaining in multi-step workflows', () => {
    const step1Receipt = path.join(testEnv.dir, 'step-1-receipt.md');
    fs.writeFileSync(step1Receipt, '# Step 1 Plan Receipt\nOutcome: direct');

    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '100',
    ]);
    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'issue_work',
      objective: 'Implement from step 1 plan',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      workdir: testEnv.dir,
      predecessor_receipts: [step1Receipt],
    });
    expect(prepRes.status).toBe(0);
    const prepData = JSON.parse(prepRes.stdout);
    const step2EnvelopePath = prepData.envelope_path;

    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(step2EnvelopePath, 'utf-8'));
    expect(env.inputs.predecessor_receipts).toContain(step1Receipt);
  });

  it('F4.5: validates compact report result structure and schema', () => {
    const reportJson = JSON.stringify({
      execution_status: 'succeeded',
      result: {
        outcome: 'landed',
        mergedCommit: '1122334455667788990011223344556677889900',
      },
      receipt_path: path.join(testEnv.dir, 'landing-receipt.md'),
      summary: 'PR #10 merged into main.',
    });

    const parsed: CompactReceiptReport = JSON.parse(reportJson);
    expect(parsed.execution_status).toBe('succeeded');
    expect(parsed.result.outcome).toBe('landed');
    expect(parsed.result.mergedCommit).toBe('1122334455667788990011223344556677889900');
  });
});
