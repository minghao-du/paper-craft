/**
 * @fileoverview Workflow configuration management: schema defaults, scaffolding, parser, and validator.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import type {
  InitOptions,
  RoleDefinitions,
  WorkflowConfig,
  WorkflowDefinition,
} from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Standard default workflow for atomic Issue delivery.
 */
export const DEFAULT_WORKFLOW_DEFINITION: WorkflowDefinition = {
  initial_step: 'implementation',
  rework_limit: 3,
  steps: {
    implementation: {
      role: 'worker',
      guidance: 'Implement the requested changes adhering to acceptance criteria',
      transitions: {
        completed: 'review',
        blocked: 'blocked',
      },
    },
    review: {
      role: 'reviewer',
      guidance: 'Review implementation against acceptance criteria and quality standards',
      transitions: {
        pass: 'merge',
        rework: 'implementation',
        blocked: 'blocked',
      },
    },
    merge: {
      role: 'merger',
      guidance: 'Verify PR head matches approved review commit and merge',
      transitions: {
        completed: 'finalization',
        blocked: 'blocked',
      },
    },
    finalization: {
      role: 'finalizer',
      guidance: 'Record final records, preserve artifacts, and release resources',
      transitions: {
        completed: 'completed',
        blocked: 'blocked',
      },
    },
  },
};

/**
 * Standard role contracts for the default delivery roles.
 */
export const DEFAULT_ROLE_DEFINITIONS: RoleDefinitions = {
  roles: {
    worker: {
      skill: 'pc-issue-work',
      permitted_outcomes: ['completed', 'blocked'],
      required_artifacts: ['diff', 'test_results'],
    },
    reviewer: {
      skill: 'pc-pr-review',
      permitted_outcomes: ['pass', 'rework', 'blocked'],
      required_artifacts: ['reviewed_commit', 'findings'],
    },
    merger: {
      skill: 'pc-pr-land',
      permitted_outcomes: ['completed', 'blocked'],
      required_artifacts: ['merged_commit'],
    },
    finalizer: {
      skill: 'pc-pr-land',
      permitted_outcomes: ['completed', 'blocked'],
      required_artifacts: ['release_evidence'],
    },
  },
};

/**
 * Attempts to detect repository slug (owner/repo) from local git remote.
 */
export async function detectGitRepository(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd });
    const trimmed = stdout.trim();
    // Match git@github.com:owner/repo.git or https://github.com/owner/repo.git
    const match = trimmed.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/);
    if (match && match[1]) {
      return match[1];
    }
  } catch {
    // Ignore git failures (e.g. not a git repo or no origin)
  }
  return '';
}

/**
 * Scaffolds workflow configuration files in the target directory.
 */
export async function initWorkflowConfig(
  cwd: string,
  options?: InitOptions,
): Promise<{ configPath: string }> {
  const targetConfigPath = options?.configPath
    ? path.resolve(cwd, options.configPath)
    : path.join(cwd, '.pc-workflow.yml');

  const configDir = path.dirname(targetConfigPath);
  await fs.mkdir(configDir, { recursive: true });

  const detectedRepo = await detectGitRepository(cwd);
  const repository = options?.repository !== undefined ? options.repository : (detectedRepo || 'owner/repo');
  const worktreeRoot = options?.worktreeRoot ?? '.worktrees';
  const provider = options?.provider ?? 'agy';

  if (options?.inline) {
    const configObj: WorkflowConfig = {
      repository,
      worktree_root: worktreeRoot,
      workflow_definition: DEFAULT_WORKFLOW_DEFINITION,
      role_definitions: DEFAULT_ROLE_DEFINITIONS,
      rework_limit: 3,
      provider,
    };
    await fs.writeFile(targetConfigPath, YAML.stringify(configObj), 'utf8');
    return { configPath: targetConfigPath };
  }

  // Create external definition files
  const wfDefRelPath = 'config/workflow.yml';
  const roleDefRelPath = 'config/roles.yml';

  const wfDefAbsPath = path.resolve(configDir, wfDefRelPath);
  const roleDefAbsPath = path.resolve(configDir, roleDefRelPath);

  await fs.mkdir(path.dirname(wfDefAbsPath), { recursive: true });
  await fs.mkdir(path.dirname(roleDefAbsPath), { recursive: true });

  await fs.writeFile(wfDefAbsPath, YAML.stringify(DEFAULT_WORKFLOW_DEFINITION), 'utf8');
  await fs.writeFile(roleDefAbsPath, YAML.stringify(DEFAULT_ROLE_DEFINITIONS), 'utf8');

  const configObj: WorkflowConfig = {
    repository,
    worktree_root: worktreeRoot,
    workflow_definition: wfDefRelPath,
    role_definitions: roleDefRelPath,
    rework_limit: 3,
    provider,
  };

  await fs.writeFile(targetConfigPath, YAML.stringify(configObj), 'utf8');
  return { configPath: targetConfigPath };
}

/**
 * Discovers and resolves the path to the workflow configuration file.
 */
export async function resolveConfigPath(cwd: string, explicitPath?: string): Promise<string> {
  if (explicitPath) {
    const resolved = path.resolve(cwd, explicitPath);
    try {
      await fs.access(resolved);
      return resolved;
    } catch {
      throw new Error(`Workflow configuration file not found at: ${resolved}`);
    }
  }

  const candidates = [
    path.join(cwd, '.pc-workflow.yml'),
    path.join(cwd, '.pc-workflow.yaml'),
    path.join(cwd, '.epic-config.json'),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue searching candidates
    }
  }

  throw new Error(
    `No workflow configuration found in "${cwd}". Run "pc workflow init" to initialize.`,
  );
}

/**
 * Loads, parses, and validates the workflow configuration and linked definition files.
 */
export async function loadWorkflowConfig(
  cwd: string,
  explicitPath?: string,
): Promise<{
  config: WorkflowConfig;
  configPath: string;
  workflow: WorkflowDefinition;
  roles: RoleDefinitions;
}> {
  const configPath = await resolveConfigPath(cwd, explicitPath);
  const configDir = path.dirname(configPath);
  const rawContent = await fs.readFile(configPath, 'utf8');

  let parsed: unknown;
  if (configPath.endsWith('.json')) {
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      throw new Error(`Failed to parse JSON configuration file "${configPath}": ${(err as Error).message}`, {
        cause: err,
      });
    }
  } else {
    try {
      parsed = YAML.parse(rawContent);
    } catch (err) {
      throw new Error(`Failed to parse YAML configuration file "${configPath}": ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid configuration format in "${configPath}": expected an object`);
  }

  const config = parsed as WorkflowConfig;

  // Resolve workflow definition
  let workflow: WorkflowDefinition;
  if (typeof config.workflow_definition === 'string') {
    const wfPath = path.resolve(configDir, config.workflow_definition);
    try {
      const wfRaw = await fs.readFile(wfPath, 'utf8');
      workflow = wfPath.endsWith('.json') ? JSON.parse(wfRaw) : YAML.parse(wfRaw);
    } catch (err) {
      throw new Error(`Failed to load workflow definition from "${wfPath}": ${(err as Error).message}`, {
        cause: err,
      });
    }
  } else if (config.workflow_definition && typeof config.workflow_definition === 'object') {
    workflow = config.workflow_definition;
  } else {
    throw new Error(`Configuration "${configPath}" is missing a valid "workflow_definition" property.`);
  }

  // Resolve role definitions
  let roles: RoleDefinitions;
  if (typeof config.role_definitions === 'string') {
    const rolesPath = path.resolve(configDir, config.role_definitions);
    try {
      const rolesRaw = await fs.readFile(rolesPath, 'utf8');
      roles = rolesPath.endsWith('.json') ? JSON.parse(rolesRaw) : YAML.parse(rolesRaw);
    } catch (err) {
      throw new Error(`Failed to load role definitions from "${rolesPath}": ${(err as Error).message}`, {
        cause: err,
      });
    }
  } else if (config.role_definitions && typeof config.role_definitions === 'object') {
    roles = config.role_definitions;
  } else {
    throw new Error(`Configuration "${configPath}" is missing a valid "role_definitions" property.`);
  }

  validateWorkflowConfiguration(config, workflow, roles);

  return {
    config,
    configPath,
    workflow,
    roles,
  };
}

/**
 * Validates the schema, step references, role assignments, and transitions.
 */
export function validateWorkflowConfiguration(
  config: WorkflowConfig,
  workflow: WorkflowDefinition,
  roles: RoleDefinitions,
): void {
  if (!config.repository || typeof config.repository !== 'string' || !config.repository.trim()) {
    throw new Error('Configuration validation error: repository is required and must be non-empty.');
  }

  if (!config.worktree_root || typeof config.worktree_root !== 'string' || !config.worktree_root.trim()) {
    throw new Error('Configuration validation error: worktree_root is required and must be non-empty.');
  }

  if (typeof config.rework_limit !== 'number' || !Number.isInteger(config.rework_limit) || config.rework_limit < 0) {
    throw new Error(
      `Configuration validation error: rework_limit must be a non-negative integer, received ${config.rework_limit}.`,
    );
  }

  if (!roles || !roles.roles || typeof roles.roles !== 'object' || Object.keys(roles.roles).length === 0) {
    throw new Error('Role definitions validation error: must declare at least one role in "roles".');
  }

  for (const [roleName, roleContract] of Object.entries(roles.roles)) {
    if (!roleContract.skill || typeof roleContract.skill !== 'string') {
      throw new Error(`Role "${roleName}" must define a non-empty "skill".`);
    }
    if (!Array.isArray(roleContract.permitted_outcomes) || roleContract.permitted_outcomes.length === 0) {
      throw new Error(`Role "${roleName}" must declare a non-empty array of "permitted_outcomes".`);
    }
  }

  if (!workflow || !workflow.steps || typeof workflow.steps !== 'object' || Object.keys(workflow.steps).length === 0) {
    throw new Error('Workflow definition validation error: must declare at least one step in "steps".');
  }

  if (!workflow.initial_step || typeof workflow.initial_step !== 'string') {
    throw new Error('Workflow definition validation error: "initial_step" is required.');
  }

  if (!workflow.steps[workflow.initial_step]) {
    throw new Error(
      `Workflow definition validation error: initial_step "${workflow.initial_step}" is not defined in steps. Available steps: ${Object.keys(workflow.steps).join(', ')}.`,
    );
  }

  const validTerminalStates = new Set(['completed', 'blocked']);

  for (const [stepName, stepDef] of Object.entries(workflow.steps)) {
    if (!stepDef.role || !roles.roles[stepDef.role]) {
      throw new Error(
        `Workflow definition validation error: step "${stepName}" references undeclared role "${stepDef.role}". Available roles: ${Object.keys(roles.roles).join(', ')}.`,
      );
    }

    const assignedRoleContract = roles.roles[stepDef.role];
    const permittedOutcomes = new Set([...assignedRoleContract.permitted_outcomes, 'blocked']);

    if (!stepDef.transitions || typeof stepDef.transitions !== 'object') {
      throw new Error(`Step "${stepName}" must define a "transitions" mapping.`);
    }

    for (const [outcome, targetStep] of Object.entries(stepDef.transitions)) {
      if (!permittedOutcomes.has(outcome)) {
        throw new Error(
          `Workflow definition validation error: transition outcome "${outcome}" is not permitted for role "${stepDef.role}" in step "${stepName}". Permitted outcomes: ${Array.from(permittedOutcomes).join(', ')}.`,
        );
      }

      const isValidTarget = Boolean(workflow.steps[targetStep]) || validTerminalStates.has(targetStep);
      if (!isValidTarget) {
        throw new Error(
          `Workflow definition validation error: transition target "${targetStep}" is neither a defined step nor a terminal state ('completed', 'blocked') in step "${stepName}".`,
        );
      }
    }
  }
}
