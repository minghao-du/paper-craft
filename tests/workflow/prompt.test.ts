import { describe, it, expect } from 'vitest';
import { composeTaskPrompt } from '../../packages/core/src/workflow/prompt.js';
import type { TaskDispatchParams } from '../../packages/core/src/workflow/types.js';

describe('composeTaskPrompt', () => {
  it('structures complete prompt with task context and scheduling directives', () => {
    const params: TaskDispatchParams = {
      runId: 'run-12345',
      taskId: 'task-67890',
      step: 'implementation',
      role: 'worker',
      skill: 'pc-issue-work',
      taskInstructions: 'Implement Ticket #25 decoupled prompt mechanism',
      sharedRequirements: 'Follow TDD and strict TypeScript standards.',
      worktreePath: '/path/to/worktree/issue-25',
      repository: 'owner/repo',
      issue: 25,
      permittedOutcomes: ['completed', 'blocked'],
      requiredArtifacts: ['diff', 'test_results'],
      priorEvidence: {
        evaluatedCommit: 'commit-abc',
        findings: 'Ensure backward compatibility.',
        priorSummary: 'Initial exploration done.',
      },
      deliveryArtifacts: {
        design_doc: 'docs/design.md',
      },
      inputs: {
        featureFlag: true,
        mode: 'strict',
      },
    };

    const prompt = composeTaskPrompt(params);

    // 1. Task Context
    expect(prompt).toContain('Skill: pc-issue-work');
    expect(prompt).toContain('Role: worker');
    expect(prompt).toContain('Step: implementation');
    expect(prompt).toContain('Repository: owner/repo');
    expect(prompt).toContain('Issue: #25');
    expect(prompt).toContain('Working Directory: /path/to/worktree/issue-25');
    expect(prompt).toContain('Implement Ticket #25 decoupled prompt mechanism');
    expect(prompt).toContain('Follow TDD and strict TypeScript standards.');

    // Caller inputs
    expect(prompt).toContain('featureFlag: true');
    expect(prompt).toContain('mode: strict');

    // Delivery artifacts
    expect(prompt).toContain('design_doc: docs/design.md');

    // Prior evidence
    expect(prompt).toContain('Evaluated Commit: commit-abc');
    expect(prompt).toContain('Ensure backward compatibility.');
    expect(prompt).toContain('Prior Summary: Initial exploration done.');

    // 2. Scheduling Directives
    expect(prompt).toContain('Run ID: run-12345');
    expect(prompt).toContain('Task ID: task-67890');
    expect(prompt).toContain('Permitted Outcomes: completed, blocked');
    expect(prompt).toContain('Required Artifacts: diff, test_results');
    expect(prompt).toContain(
      'pc workflow submit-result --run "run-12345" --task "task-67890" --outcome <outcome> --summary "<summary>" --artifacts \'<artifacts-json>\'',
    );

    // Responsible agent directive
    expect(prompt).toContain('The top-level dispatch agent is responsible for returning the receipt');
  });

  it('handles optional fields gracefully when omitted', () => {
    const params: TaskDispatchParams = {
      runId: 'run-min',
      taskId: 'task-min',
      step: 'implementation',
      role: 'worker',
      skill: 'pc-issue-work',
      taskInstructions: 'Minimal task instructions',
      worktreePath: '/tmp/worktree',
      repository: 'owner/min',
      issue: 1,
      permittedOutcomes: ['completed'],
    };

    const prompt = composeTaskPrompt(params);

    expect(prompt).toContain('Skill: pc-issue-work');
    expect(prompt).toContain('Role: worker');
    expect(prompt).toContain('Step: implementation');
    expect(prompt).toContain('Repository: owner/min');
    expect(prompt).toContain('Issue: #1');
    expect(prompt).toContain('Working Directory: /tmp/worktree');
    expect(prompt).toContain('Minimal task instructions');
    expect(prompt).toContain('None specified.');
    expect(prompt).toContain('Required Artifacts: None');
    expect(prompt).not.toContain('## Caller Inputs');
    expect(prompt).not.toContain('## Delivery Artifacts');
    expect(prompt).not.toContain('## Prior Evidence');
    expect(prompt).toContain(
      'pc workflow submit-result --run "run-min" --task "task-min" --outcome <outcome> --summary "<summary>" --artifacts \'<artifacts-json>\'',
    );
  });

  it('composes reviewer prompt with pc-pr-review and permitted outcomes', () => {
    const params: TaskDispatchParams = {
      runId: 'run-rev-1',
      taskId: 'task-rev-1',
      step: 'review',
      role: 'reviewer',
      skill: 'pc-pr-review',
      taskInstructions: 'Review implementation against acceptance criteria and quality standards',
      sharedRequirements: 'Production quality code, 100% tests passing.',
      worktreePath: '/worktrees/run-rev-1',
      repository: 'test-org/test-repo',
      issue: 26,
      permittedOutcomes: ['pass', 'rework', 'blocked'],
      requiredArtifacts: ['reviewed_commit', 'findings'],
      deliveryArtifacts: {
        diff: 'diff --git a/file.ts b/file.ts',
        test_results: 'All 12 tests passed',
      },
    };

    const prompt = composeTaskPrompt(params);

    expect(prompt).toContain('# Task Assignment: review (reviewer)');
    expect(prompt).toContain('Skill: pc-pr-review');
    expect(prompt).toContain('Role: reviewer');
    expect(prompt).toContain('Step: review');
    expect(prompt).toContain('Permitted Outcomes: pass, rework, blocked');
    expect(prompt).toContain('Required Artifacts: reviewed_commit, findings');
    expect(prompt).toContain('diff: diff --git a/file.ts b/file.ts');
    expect(prompt).toContain('test_results: All 12 tests passed');
    expect(prompt).toContain('pc workflow submit-result --run "run-rev-1" --task "task-rev-1"');
  });

  it('composes merger prompt with pc-pr-land and evaluated commit evidence', () => {
    const params: TaskDispatchParams = {
      runId: 'run-merge-1',
      taskId: 'task-merge-1',
      step: 'merge',
      role: 'merger',
      skill: 'pc-pr-land',
      taskInstructions: 'Verify PR head matches approved review commit and merge',
      sharedRequirements: 'Must use guarded squash merge.',
      worktreePath: '/worktrees/run-merge-1',
      repository: 'test-org/test-repo',
      issue: 26,
      permittedOutcomes: ['completed', 'blocked'],
      requiredArtifacts: ['merged_commit'],
      priorEvidence: {
        evaluatedCommit: 'commit-approved-789',
        findings: 'Review passed with 0 defects.',
      },
    };

    const prompt = composeTaskPrompt(params);

    expect(prompt).toContain('# Task Assignment: merge (merger)');
    expect(prompt).toContain('Skill: pc-pr-land');
    expect(prompt).toContain('Role: merger');
    expect(prompt).toContain('Step: merge');
    expect(prompt).toContain('Permitted Outcomes: completed, blocked');
    expect(prompt).toContain('Required Artifacts: merged_commit');
    expect(prompt).toContain('Evaluated Commit: commit-approved-789');
    expect(prompt).toContain('Review Findings:\nReview passed with 0 defects.');
    expect(prompt).toContain('pc workflow submit-result --run "run-merge-1" --task "task-merge-1"');
  });

  it('composes finalizer prompt with pc-pr-land and release evidence contract', () => {
    const params: TaskDispatchParams = {
      runId: 'run-fin-1',
      taskId: 'task-fin-1',
      step: 'finalization',
      role: 'finalizer',
      skill: 'pc-pr-land',
      taskInstructions: 'Record final records, preserve artifacts, and release resources',
      sharedRequirements: 'Verify preservation before releasing.',
      worktreePath: '/worktrees/run-fin-1',
      repository: 'test-org/test-repo',
      issue: 26,
      permittedOutcomes: ['completed', 'blocked'],
      requiredArtifacts: ['release_evidence'],
      deliveryArtifacts: {
        merged_commit: 'commit-merged-squash-999',
      },
    };

    const prompt = composeTaskPrompt(params);

    expect(prompt).toContain('# Task Assignment: finalization (finalizer)');
    expect(prompt).toContain('Skill: pc-pr-land');
    expect(prompt).toContain('Role: finalizer');
    expect(prompt).toContain('Step: finalization');
    expect(prompt).toContain('Permitted Outcomes: completed, blocked');
    expect(prompt).toContain('Required Artifacts: release_evidence');
    expect(prompt).toContain('merged_commit: commit-merged-squash-999');
    expect(prompt).toContain('pc workflow submit-result --run "run-fin-1" --task "task-fin-1"');
  });
});
