/**
 * Automated test suite for the Missing Input Protocol.
 *
 * Verifies that:
 * 1. Prerequisite input detection accurately identifies present vs missing files.
 * 2. Missing inputs format the standardized 3-part interactive halt notification.
 * 3. Workflows halt cleanly before coding when prerequisite inputs are absent from disk,
 *    refusing to proceed to branch creation or implementation.
 * 4. skills/pc-issue-work/SKILL.md adheres to the protocol contract and conventions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  verifyPrerequisiteInputs,
  assertPrerequisiteInputs,
  formatMissingInputNotification,
  MissingInputHaltError,
  executeWorkflowSteps,
  HALT_HEADER,
  HALT_ACTION_PROMPT,
  type PrerequisiteInput,
  type WorkflowStep,
} from '../../src/workflow/input-verification.js';

describe('Missing Input Protocol', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pc-workflow-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Prerequisite Input Verification', () => {
    it('passes when all prerequisite files exist on disk', async () => {
      const modelPath = join(tempDir, 'models', 'bert-base.pt');
      const dataPath = join(tempDir, 'data', 'eval.tsv');

      await mkdir(join(tempDir, 'models'), { recursive: true });
      await mkdir(join(tempDir, 'data'), { recursive: true });
      await writeFile(modelPath, 'dummy-weights');
      await writeFile(dataPath, 'id\tscore\n1\t0.9');

      const inputs: PrerequisiteInput[] = [
        { path: 'models/bert-base.pt', operation: 'eval_benchmark.py' },
        { path: 'data/eval.tsv', operation: 'metric_calculation' },
      ];

      const result = verifyPrerequisiteInputs(inputs, { baseDir: tempDir });
      expect(result.ok).toBe(true);
      expect(result.missing).toHaveLength(0);
      expect(result.haltMessage).toBeUndefined();
    });

    it('identifies missing input files and returns detailed missing list', async () => {
      const dataPath = join(tempDir, 'data', 'eval.tsv');
      await mkdir(join(tempDir, 'data'), { recursive: true });
      await writeFile(dataPath, 'id\tscore\n1\t0.9');

      const inputs: PrerequisiteInput[] = [
        { path: 'models/bert-base.pt', operation: 'eval_benchmark.py' },
        { path: 'data/eval.tsv', operation: 'metric_calculation' },
        { path: 'fixtures/embeddings.joblib', operation: 'eval_benchmark.py' },
      ];

      const result = verifyPrerequisiteInputs(inputs, { baseDir: tempDir });
      expect(result.ok).toBe(false);
      expect(result.missing).toHaveLength(2);
      expect(result.missing.map((m) => m.path)).toEqual([
        'models/bert-base.pt',
        'fixtures/embeddings.joblib',
      ]);
      expect(result.haltMessage).toBeDefined();
    });

    it('supports absolute paths in prerequisite definitions', async () => {
      const absMissingPath = join(tempDir, 'nonexistent', 'table.csv');
      const inputs: PrerequisiteInput[] = [{ path: absMissingPath, operation: 'data_loader_step' }];

      const result = verifyPrerequisiteInputs(inputs);
      expect(result.ok).toBe(false);
      expect(result.missing[0].path).toBe(absMissingPath);
    });
  });

  describe('Standardized 3-Part Halt Notification Formatting', () => {
    it('formats the exact 3-part notification for a missing input', () => {
      const input: PrerequisiteInput = {
        path: 'models/classifier.joblib',
        operation: 'eval_benchmark.py validation',
      };

      const message = formatMissingInputNotification(input);
      const lines = message.split('\n');

      expect(lines[0]).toBe(HALT_HEADER);
      expect(lines[1]).toBe('- 缺失文件及预期路径: `models/classifier.joblib`');
      expect(lines[2]).toBe('- 依赖该文件的操作: <eval_benchmark.py validation>');
      expect(lines[3]).toBe(HALT_ACTION_PROMPT);
    });

    it('matches the canonical template with placeholder paths', () => {
      const input: PrerequisiteInput = {
        path: '<relative/path/to/file>',
        operation: '<说明是哪个评测脚本/验证步骤需要它>',
      };

      const message = formatMissingInputNotification(input);
      expect(message).toBe(
        [
          '🚨 缺少前置依赖输入文件，无法继续执行任务：',
          '- 缺失文件及预期路径: `<relative/path/to/file>`',
          '- 依赖该文件的操作: `<说明是哪个评测脚本/验证步骤需要它>`',
          '- 请操作: 请将该文件放置在上述指定路径，或者告知替代的 mock 方案 / 是否授权重新生成？',
        ].join('\n'),
      );
    });

    it('handles multiple missing inputs in a unified notification', () => {
      const inputs: PrerequisiteInput[] = [
        { path: 'models/net.pt', operation: 'eval_net.py' },
        { path: 'data/test.csv', operation: 'eval_test.py' },
      ];

      const message = formatMissingInputNotification(inputs);
      expect(message).toContain(HALT_HEADER);
      expect(message).toContain('- 缺失文件及预期路径: `models/net.pt`');
      expect(message).toContain('- 依赖该文件的操作: <eval_net.py>');
      expect(message).toContain('- 缺失文件及预期路径: `data/test.csv`');
      expect(message).toContain('- 依赖该文件的操作: <eval_test.py>');
      expect(message).toContain(HALT_ACTION_PROMPT);
    });
  });

  describe('Workflow Gate Runner: Halt Before Implementation', () => {
    it('halts workflow cleanly before coding when prerequisite is missing', async () => {
      const step1ReadIssue = vi.fn();
      const step3CreateBranch = vi.fn();
      const step4Implement = vi.fn();

      const requiredInputs: PrerequisiteInput[] = [
        {
          path: 'checkpoints/model_best.pt',
          operation: 'reproduce_benchmark.py',
        },
      ];

      const steps: WorkflowStep[] = [
        {
          name: 'Step 1: Read the issue',
          execute: () => {
            step1ReadIssue();
          },
        },
        {
          name: 'Step 2: Input verification',
          execute: () => {
            assertPrerequisiteInputs(requiredInputs, { baseDir: tempDir });
          },
        },
        {
          name: 'Step 3: Create a feature branch',
          execute: () => {
            step3CreateBranch();
          },
        },
        {
          name: 'Step 4: Implement',
          execute: () => {
            step4Implement();
          },
        },
      ];

      let thrownError: unknown;
      let executedSteps: string[] = [];

      try {
        executedSteps = await executeWorkflowSteps(steps);
      } catch (err) {
        thrownError = err;
      }

      // Workflow must have halted at Step 2
      expect(thrownError).toBeInstanceOf(MissingInputHaltError);
      const haltErr = thrownError as MissingInputHaltError;

      // Emits standardized 3-part notification
      expect(haltErr.haltNotification).toContain(HALT_HEADER);
      expect(haltErr.haltNotification).toContain('`checkpoints/model_best.pt`');
      expect(haltErr.haltNotification).toContain('<reproduce_benchmark.py>');
      expect(haltErr.haltNotification).toContain(HALT_ACTION_PROMPT);

      // Verify execution boundary: Step 1 ran, but coding steps (3 and 4) NEVER ran
      expect(step1ReadIssue).toHaveBeenCalledTimes(1);
      expect(step3CreateBranch).not.toHaveBeenCalled();
      expect(step4Implement).not.toHaveBeenCalled();
      expect(executedSteps).toEqual([]);
    });

    it('proceeds through all steps when prerequisite inputs exist', async () => {
      const checkpointPath = join(tempDir, 'checkpoints', 'model_best.pt');
      await mkdir(join(tempDir, 'checkpoints'), { recursive: true });
      await writeFile(checkpointPath, 'checkpoint-data');

      const step1ReadIssue = vi.fn();
      const step3CreateBranch = vi.fn();
      const step4Implement = vi.fn();

      const requiredInputs: PrerequisiteInput[] = [
        {
          path: 'checkpoints/model_best.pt',
          operation: 'reproduce_benchmark.py',
        },
      ];

      const steps: WorkflowStep[] = [
        {
          name: 'Step 1: Read the issue',
          execute: () => {
            step1ReadIssue();
          },
        },
        {
          name: 'Step 2: Input verification',
          execute: () => {
            assertPrerequisiteInputs(requiredInputs, { baseDir: tempDir });
          },
        },
        {
          name: 'Step 3: Create a feature branch',
          execute: () => {
            step3CreateBranch();
          },
        },
        {
          name: 'Step 4: Implement',
          execute: () => {
            step4Implement();
          },
        },
      ];

      const completed = await executeWorkflowSteps(steps);

      expect(step1ReadIssue).toHaveBeenCalledTimes(1);
      expect(step3CreateBranch).toHaveBeenCalledTimes(1);
      expect(step4Implement).toHaveBeenCalledTimes(1);
      expect(completed).toEqual([
        'Step 1: Read the issue',
        'Step 2: Input verification',
        'Step 3: Create a feature branch',
        'Step 4: Implement',
      ]);
    });
  });

  describe('Skill Document Contract: pc-issue-work', () => {
    it('contains Step 2 Input Verification with exact 3-part notification template', async () => {
      const skillPath = join(process.cwd(), 'skills', 'pc-issue-work', 'SKILL.md');
      const content = await readFile(skillPath, 'utf-8');

      // Step 2 heading exists
      expect(content).toContain('### Step 2: Input verification');

      // Exact 3-part notification exists
      expect(content).toContain('🚨 缺少前置依赖输入文件，无法继续执行任务：');
      expect(content).toContain('- 缺失文件及预期路径: `<relative/path/to/file>`');
      expect(content).toContain('- 依赖该文件的操作: `<说明是哪个评测脚本/验证步骤需要它>`');
      expect(content).toContain(
        '- 请操作: 请将该文件放置在上述指定路径，或者告知替代的 mock 方案 / 是否授权重新生成？',
      );

      // Explicit prohibitions from ticket #10 are present
      expect(content).toMatch(/Never guess missing values/i);
      expect(content).toMatch(/fabricate mock data/i);
      expect(content).toMatch(/launch unapproved long-running recalculations/i);

      // Halts immediately before coding
      expect(content).toMatch(/Halt immediately/i);

      // Checkable completion criterion
      expect(content).toContain('Completion criterion:');
    });

    it('adheres to single sentence per line in skill prose per CONVENTIONS.md', async () => {
      const skillPath = join(process.cwd(), 'skills', 'pc-issue-work', 'SKILL.md');
      const content = await readFile(skillPath, 'utf-8');

      // Extract lines in Step 2 section
      const step2Index = content.indexOf('### Step 2: Input verification');
      const step3Index = content.indexOf('### Step 3: Create a feature branch');
      const step2Section = content.slice(step2Index, step3Index);

      const lines = step2Section.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        // Ignore empty lines, headings, code fences, markdown block quotes, and template blocks
        if (
          !trimmed ||
          trimmed.startsWith('#') ||
          trimmed.startsWith('```') ||
          trimmed.startsWith('🚨') ||
          trimmed.startsWith('- 缺失文件') ||
          trimmed.startsWith('- 依赖该文件') ||
          trimmed.startsWith('- 请操作')
        ) {
          continue;
        }

        // Prose lines should not contain multiple sentence-terminating punctuations followed by a space
        const sentenceBreaks = trimmed.match(/[.!?]\s+[A-Z]/g);
        expect(
          sentenceBreaks,
          `Line contains multiple sentences instead of semantic line break: "${trimmed}"`,
        ).toBeNull();
      }
    });
  });
});
