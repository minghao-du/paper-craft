/**
 * @fileoverview Assignments submodule for Run.
 * Binds caller inputs, pins task contracts (version 1.0), formats execution prompts
 * with injected task identity and delivery requirements, and validates submissions.
 * Does not contain scheduling state machines or external API lookups.
 */

import type { TaskResult } from './types.js';

/**
 * Predecessor result binding details for repair/rework tasks.
 */
export interface PredecessorBinding {
  /** Identifier of the predecessor task whose result is being addressed. */
  predecessorResultId: string;
  /** Summary or detail of findings from the predecessor review/check. */
  findings?: string;
  /** Commit SHA evaluated in the predecessor task. */
  previousHeadSha?: string;
  /** Original constraints or requirements from the initial task. */
  originalConstraints?: string[] | string;
}

/**
 * Formal schema contract defining expectations for a specific task type.
 */
export interface TaskContract {
  /** Target task type identifier (e.g. 'pc-issue-work'). */
  taskType: string;
  /** Canonical skill name invoked for this task type. */
  skill: string;
  /** Pinned specification version (strictly '1.0'). */
  version: '1.0';
  /** Permitted business outcome strings. */
  permittedOutcomes: string[];
  /** Required artifact keys expected when outcome is completed. */
  requiredArtifacts: string[];
}

/**
 * Prepared assignment returned by Assignments.prepare.
 */
export interface PreparedAssignment {
  /** Unique stable task identifier. */
  taskId: string;
  /** Owning Run identifier. */
  runId: string;
  /** Task type name. */
  taskType: string;
  /** Canonical skill name. */
  skill: string;
  /** Pinned contract version. */
  contractVersion: '1.0';
  /** Complete agent prompt with injected identity and delivery expectations. */
  prompt: string;
  /** Task initialization file payload written into the worktree. */
  initializationPayload: Record<string, unknown>;
}

/**
 * Result returned by Assignments.validate.
 */
export interface AssignmentValidationResult {
  /** Whether the submitted result satisfies the contract. */
  valid: boolean;
  /** Conforming normalized TaskResult if valid. */
  normalizedResult?: TaskResult;
  /** List of validation error messages if invalid. */
  errors?: string[];
}

/**
 * Default task contracts pinned to version 1.0.
 */
export const DEFAULT_TASK_CONTRACTS: Record<string, TaskContract> = {
  'pc-issue-work': {
    taskType: 'pc-issue-work',
    skill: 'pc-issue-work',
    version: '1.0',
    permittedOutcomes: ['completed', 'blocked'],
    requiredArtifacts: ['diff', 'testResults', 'summary'],
  },
  'pc-issue-plan': {
    taskType: 'pc-issue-plan',
    skill: 'pc-issue-plan',
    version: '1.0',
    permittedOutcomes: ['direct', 'decomposed', 'verified', 'rework_needed', 'blocked'],
    requiredArtifacts: ['summary'],
  },
  'pc-pr-land': {
    taskType: 'pc-pr-land',
    skill: 'pc-pr-land',
    version: '1.0',
    permittedOutcomes: ['landed', 'rework_needed', 'blocked'],
    requiredArtifacts: ['summary'],
  },
  'pc-pipeline-refactor': {
    taskType: 'pc-pipeline-refactor',
    skill: 'pc-pipeline-refactor',
    version: '1.0',
    permittedOutcomes: ['completed', 'no_change', 'out_of_scope', 'blocked'],
    requiredArtifacts: ['changedFiles', 'verificationEvidence'],
  },
  'pc-research-state': {
    taskType: 'pc-research-state',
    skill: 'pc-research-state',
    version: '1.0',
    permittedOutcomes: ['recorded', 'blocked'],
    requiredArtifacts: ['updatedRecords', 'summary'],
  },
};

/**
 * Submodule responsible for task input binding, contract pinning,
 * prompt assembly, and output verification.
 */
export class Assignments {
  private readonly contracts = new Map<string, TaskContract>();

  constructor(customContracts?: Record<string, TaskContract>) {
    // Load defaults
    for (const [key, contract] of Object.entries(DEFAULT_TASK_CONTRACTS)) {
      this.contracts.set(key, contract);
    }
    // Load overrides or additions
    if (customContracts) {
      for (const [key, contract] of Object.entries(customContracts)) {
        this.contracts.set(key, contract);
      }
    }
  }

  /**
   * Registers a new or overridden TaskContract.
   */
  registerContract(contract: TaskContract): void {
    this.contracts.set(contract.taskType, contract);
  }

  /**
   * Retrieves the contract for a given task type, or throws if unknown.
   */
  getContract(taskType: string): TaskContract {
    const contract = this.contracts.get(taskType);
    if (!contract) {
      throw new Error(`Unknown task type "${taskType}". No task contract registered.`);
    }
    return contract;
  }

  /**
   * Prepares a task assignment: binds inputs, pins contract version 1.0,
   * generates prompt with injected identity, repair/predecessor context,
   * delivery expectations, and creates the initialization file payload.
   */
  prepare(params: {
    runId: string;
    taskId: string;
    taskType: string;
    worktreePath: string;
    instructions: string;
    inputs?: Record<string, unknown>;
    predecessor?: PredecessorBinding;
  }): PreparedAssignment {
    const contract = this.getContract(params.taskType);

    const sections: string[] = [];

    // 1. Task Identity
    sections.push(
      '# Task Assignment',
      `Task ID: ${params.taskId}`,
      `Run ID: ${params.runId}`,
      `Task Type: ${params.taskType}`,
      `Skill: ${contract.skill}`,
      `Working Directory: ${params.worktreePath}`,
    );

    // 2. Instructions
    sections.push('## Objectives & Instructions', params.instructions.trim());

    // Resolve predecessor binding if explicitly supplied or embedded in inputs
    const pred =
      params.predecessor ??
      (params.inputs?.predecessor as PredecessorBinding | undefined) ??
      (params.inputs?.predecessorResultId
        ? {
            predecessorResultId: String(params.inputs.predecessorResultId),
            findings: params.inputs.findings ? String(params.inputs.findings) : undefined,
            previousHeadSha:
              params.inputs.previousHeadSha ?? params.inputs.evaluatedCommit
                ? String(params.inputs.previousHeadSha ?? params.inputs.evaluatedCommit)
                : undefined,
            originalConstraints:
              (params.inputs.originalConstraints as string[] | string | undefined) ??
              (params.inputs.constraints as string[] | string | undefined),
          }
        : undefined);

    // 3. Predecessor Findings & Repair Context (if present)
    if (pred && pred.predecessorResultId) {
      const predLines: string[] = [
        '## Predecessor Findings & Repair Context',
        `- Predecessor Task ID: ${pred.predecessorResultId}`,
      ];
      if (pred.findings) {
        predLines.push(`- Predecessor Findings: ${pred.findings}`);
      }
      if (pred.previousHeadSha) {
        predLines.push(`- Previous HEAD SHA: ${pred.previousHeadSha}`);
      }
      if (pred.originalConstraints) {
        const constraintsStr = Array.isArray(pred.originalConstraints)
          ? pred.originalConstraints.join(', ')
          : String(pred.originalConstraints);
        predLines.push(`- Original Constraints: ${constraintsStr}`);
      }
      sections.push(predLines.join('\n'));
    }

    // 4. Inputs
    if (params.inputs && Object.keys(params.inputs).length > 0) {
      sections.push('## Task Inputs');
      for (const [key, value] of Object.entries(params.inputs)) {
        if (key === 'predecessor' || key === 'predecessorResultId') {
          // Handled in predecessor section above
          continue;
        }
        if (typeof value === 'object' && value !== null) {
          sections.push(`- **${key}**:\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
        } else {
          sections.push(`- **${key}**: ${String(value)}`);
        }
      }
    }

    // 5. Delivery Requirements
    sections.push(
      '## Delivery Requirements',
      `- Contract Version: ${contract.version}`,
      `- Permitted Outcomes: ${contract.permittedOutcomes.join(', ')}`,
      `- Required Artifacts: ${contract.requiredArtifacts.length > 0 ? contract.requiredArtifacts.join(', ') : 'none'}`,
      'Submit your result or record result.json in your working directory adhering to these requirements upon completion.',
    );

    const prompt = sections.join('\n\n');

    const initializationPayload: Record<string, unknown> = {
      taskId: params.taskId,
      runId: params.runId,
      taskType: params.taskType,
      skill: contract.skill,
      contractVersion: contract.version,
      worktreePath: params.worktreePath,
      inputs: params.inputs ?? {},
      permittedOutcomes: contract.permittedOutcomes,
      requiredArtifacts: contract.requiredArtifacts,
    };

    if (pred && pred.predecessorResultId) {
      initializationPayload.predecessor = pred;
    }

    return {
      taskId: params.taskId,
      runId: params.runId,
      taskType: params.taskType,
      skill: contract.skill,
      contractVersion: contract.version,
      prompt,
      initializationPayload,
    };
  }

  /**
   * Validates a submitted result against the task contract.
   * Rejects missing required outputs or disallowed outcomes with descriptive messages.
   */
  validate(taskType: string, rawResult: unknown): AssignmentValidationResult {
    const contract = this.getContract(taskType);
    const errors: string[] = [];

    if (typeof rawResult !== 'object' || rawResult === null) {
      return {
        valid: false,
        errors: ['Submitted result must be a non-null JSON object.'],
      };
    }

    const res = rawResult as Record<string, unknown>;

    // 1. Outcome validation
    if (typeof res.outcome !== 'string' || !res.outcome.trim()) {
      errors.push('Submitted result is missing required "outcome" string.');
    } else if (!contract.permittedOutcomes.includes(res.outcome)) {
      errors.push(
        `Outcome "${res.outcome}" is not permitted for task "${taskType}". Permitted outcomes: ${contract.permittedOutcomes.join(', ')}.`,
      );
    }

    // 2. Summary validation
    if (typeof res.summary !== 'string' || !res.summary.trim()) {
      errors.push('Submitted result is missing required "summary" string.');
    }

    const artifacts = (typeof res.artifacts === 'object' && res.artifacts !== null
      ? res.artifacts
      : res) as Record<string, unknown>;

    // 3. Task-specific validation rules
    if (taskType === 'pc-issue-work' && res.outcome === 'completed') {
      const hasChanges = Boolean(
        artifacts.diff || artifacts.commitSha || artifacts.changes || res.diff || res.commitSha || res.changes,
      );
      if (!hasChanges) {
        errors.push(
          'Missing required artifact or changes (diff, commitSha, or changes) in submission for task "pc-issue-work".',
        );
      }

      const hasTestEvidence = Boolean(
        artifacts.testResults ||
          artifacts.verificationEvidence ||
          res.testResults ||
          res.verificationEvidence,
      );
      if (!hasTestEvidence) {
        errors.push(
          'Missing required artifact or test evidence (testResults or verificationEvidence) in submission for task "pc-issue-work".',
        );
      }
    } else if (taskType === 'pc-pr-land') {
      const mergedVal = artifacts.merged !== undefined ? artifacts.merged : res.merged;
      if (typeof mergedVal !== 'boolean') {
        errors.push('Missing required "merged" boolean in submission for task "pc-pr-land".');
      }

      if (res.outcome === 'landed') {
        if (mergedVal !== true) {
          errors.push('The "merged" property must be true when outcome is "landed" for task "pc-pr-land".');
        }
        const prNumber = artifacts.prNumber !== undefined ? artifacts.prNumber : res.prNumber;
        if (typeof prNumber !== 'number' || isNaN(prNumber)) {
          errors.push('Missing required "prNumber" number in submission for task "pc-pr-land".');
        }
        const prUrl = artifacts.prUrl !== undefined ? artifacts.prUrl : res.prUrl;
        if (typeof prUrl !== 'string' || !prUrl.trim()) {
          errors.push('Missing required "prUrl" string in submission for task "pc-pr-land".');
        }
      } else {
        // Outcome is not landed (e.g. 'rework_needed' or 'blocked')
        if (mergedVal === true) {
          errors.push(`The "merged" property must be false when outcome is "${res.outcome}" for task "pc-pr-land".`);
        }
        const findings = artifacts.findings !== undefined ? artifacts.findings : res.findings;
        if (typeof findings !== 'string' || !findings.trim()) {
          errors.push('Missing required "findings" string in submission for task "pc-pr-land" when not merged.');
        }
      }
    } else if (res.outcome === 'completed' || res.outcome === 'landed' || res.outcome === 'recorded') {
      // General requiredArtifacts check for other task types
      for (const requiredKey of contract.requiredArtifacts) {
        if (requiredKey === 'summary') {
          continue;
        }
        const val = artifacts[requiredKey];
        if (val === undefined || val === null || val === '') {
          errors.push(
            `Missing required artifact "${requiredKey}" in submission for task "${taskType}".`,
          );
        }
      }
    }

    if (errors.length > 0) {
      return {
        valid: false,
        errors,
      };
    }

    const combinedArtifacts: Record<string, unknown> = {
      ...(typeof res.artifacts === 'object' && res.artifacts !== null ? res.artifacts : {}),
    };
    for (const key of [
      'diff',
      'commitSha',
      'changes',
      'testResults',
      'verificationEvidence',
      'prNumber',
      'prUrl',
      'merged',
      'findings',
      'evaluatedCommit',
      'mergedCommit',
    ]) {
      if (res[key] !== undefined && combinedArtifacts[key] === undefined) {
        combinedArtifacts[key] = res[key];
      }
    }

    const normalizedResult: TaskResult = {
      outcome: res.outcome as string,
      summary: res.summary as string,
      artifacts: Object.keys(combinedArtifacts).length > 0 ? combinedArtifacts : undefined,
    };

    return {
      valid: true,
      normalizedResult,
    };
  }
}
