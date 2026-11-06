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
});
