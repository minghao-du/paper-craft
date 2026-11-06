/**
 * @fileoverview Workflow prompt composition module.
 * Formats task assignment prompts incorporating task context, repository and worktree facts,
 * operator inputs, prior evidence, and workflow scheduling directives.
 */

import type { TaskDispatchParams } from './types.js';

export type { TaskDispatchParams };

/**
 * Composes a structured task prompt for an agent execution.
 * Combines task context (skill, role, step, objectives, workspace paths, repository/issue,
 * constraints, caller inputs, delivery artifacts, prior evidence) with workflow scheduling
 * directives (run ID, task ID, permitted outcomes, required artifacts, submission command receipt).
 *
 * @param params Task dispatch parameters containing context and scheduling contracts.
 * @returns Formatted prompt string for the agent.
 */
export function composeTaskPrompt(params: TaskDispatchParams): string {
  const lines: string[] = [
    `# Task Assignment: ${params.step} (${params.role})`,
    '',
    '## Task Context',
    `- Skill: ${params.skill}`,
    `- Role: ${params.role}`,
    `- Step: ${params.step}`,
    `- Repository: ${params.repository}`,
    `- Issue: #${params.issue}`,
    `- Working Directory: ${params.worktreePath}`,
    '',
    '## Target & Objectives',
    params.taskInstructions,
    '',
    '## Constraints & Requirements',
    params.sharedRequirements || 'None specified.',
  ];

  if (params.inputs && Object.keys(params.inputs).length > 0) {
    lines.push('', '## Caller Inputs');
    for (const [key, val] of Object.entries(params.inputs)) {
      lines.push(`${key}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`);
    }
  }

  if (params.deliveryArtifacts && Object.keys(params.deliveryArtifacts).length > 0) {
    lines.push('', '## Delivery Artifacts');
    for (const [key, val] of Object.entries(params.deliveryArtifacts)) {
      lines.push(`${key}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`);
    }
  }

  if (params.priorEvidence) {
    lines.push('', '## Prior Evidence & Review Findings');
    if (params.priorEvidence.evaluatedCommit) {
      lines.push(`Evaluated Commit: ${params.priorEvidence.evaluatedCommit}`);
    }
    if (params.priorEvidence.findings) {
      lines.push(`Review Findings:\n${params.priorEvidence.findings}`);
    }
    if (params.priorEvidence.priorSummary) {
      lines.push(`Prior Summary: ${params.priorEvidence.priorSummary}`);
    }
  }

  const reqArtifacts = (params.requiredArtifacts ?? []).join(', ') || 'None';

  lines.push(
    '',
    '## Scheduling Directives',
    `- Run ID: ${params.runId}`,
    `- Task ID: ${params.taskId}`,
    `- Permitted Outcomes: ${params.permittedOutcomes.join(', ')}`,
    `- Required Artifacts: ${reqArtifacts}`,
    '',
    '### Submission Contract',
    'When finished or if blocked, submit your result using:',
    `pc workflow submit-result --run "${params.runId}" --task "${params.taskId}" --outcome <outcome> --summary "<summary>" --artifacts '<artifacts-json>'`,
    '',
    'The top-level dispatch agent is responsible for returning the receipt via this command upon task completion or blockage.',
  );

  return lines.join('\n');
}
