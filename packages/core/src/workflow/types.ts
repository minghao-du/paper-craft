/**
 * @fileoverview Core data contracts, configurations, and event schemas for the Workflow Engine.
 */

/**
 * Declares the execution configuration for a repository workflow.
 */
export interface WorkflowConfig {
  /** The target GitHub repository in owner/repo format. */
  repository: string;
  /** Root directory where execution worktrees are isolated. */
  worktree_root: string;
  /** Path to workflow definition file or inline workflow definition. */
  workflow_definition: string | WorkflowDefinition;
  /** Path to role contracts file or inline role definitions. */
  role_definitions: string | RoleDefinitions;
  /** Maximum permitted rework loops before transitioning to blocked. */
  rework_limit: number;
  /** Designated agent executor provider (e.g. 'agy'). */
  provider: string;
}

/**
 * Definition of a single workflow step.
 */
export interface WorkflowStep {
  /** Role assigned to execute this step (references RoleDefinitions). */
  role: string;
  /** Human-readable guidance and instructions for this step. */
  guidance: string;
  /** Map of permitted role outcome strings to target steps or terminal states. */
  transitions: Record<string, string>;
}

/**
 * Declarative workflow specification with steps and transitions.
 */
export interface WorkflowDefinition {
  /** The starting step for an intake Run. */
  initial_step: string;
  /** Optional override for maximum rework loops. */
  rework_limit?: number;
  /** Map of step names to step definitions. */
  steps: Record<string, WorkflowStep>;
}

/**
 * Contract defining expectations and permitted results for a specialist role.
 */
export interface RoleContract {
  /** Canonical skill invoked by this specialist role (e.g. 'pc-issue-work'). */
  skill: string;
  /** Outcomes permitted to be submitted by this role. */
  permitted_outcomes: string[];
  /** Expected artifact keys required from this role. */
  required_artifacts?: string[];
}

/**
 * Dictionary of specialist role definitions.
 */
export interface RoleDefinitions {
  /** Map of role name to role contract. */
  roles: Record<string, RoleContract>;
}

/**
 * Lifecycle status of an engine Run.
 */
export type RunStatus = 'pending_dispatch' | 'running' | 'completed' | 'blocked' | 'paused';

/**
 * Durable append-only event recorded in the run's JSONL event log.
 */
export interface RunEvent {
  /** Event discriminator type (e.g. 'run_created', 'dispatch_intent'). */
  type: string;
  /** Unique Run identifier this event belongs to. */
  run_id: string;
  /** ISO 8601 timestamp when the event occurred. */
  timestamp: string;
  /** Structured payload associated with the event. */
  payload: Record<string, unknown>;
}

/**
 * Immutable snapshot of context, definitions, and state captured for a Run.
 */
export interface RunContext {
  /** Unique identifier for the Run. */
  run_id: string;
  /** GitHub repository (owner/repo). */
  repository: string;
  /** Target GitHub issue number. */
  issue: number;
  /** Issue title if resolved. */
  issue_title?: string;
  /** Active provider handle (e.g. 'agy'). */
  provider: string;
  /** Assigned physical worktree directory path. */
  worktree_path: string;
  /** ISO timestamp when Run was created. */
  created_at: string;
  /** Current lifecycle status. */
  status: RunStatus;
  /** Active or initial workflow step. */
  current_step: string;
  /** Number of rework cycles completed. */
  rework_count: number;
  /** Immutable shared requirements text. */
  shared_requirements: string;
  /** Captured snapshot of the loaded workflow configuration. */
  config: WorkflowConfig;
  /** Captured snapshot of the workflow definition. */
  workflow: WorkflowDefinition;
  /** Captured snapshot of role contracts. */
  roles: RoleDefinitions;
}

/**
 * Options for initializing a new workflow configuration.
 */
export interface InitOptions {
  /** Target configuration file path. Defaults to `.pc-workflow.yml` in cwd. */
  configPath?: string;
  /** Target repository owner/repo. */
  repository?: string;
  /** Worktree root directory. Defaults to `.worktrees`. */
  worktreeRoot?: string;
  /** Provider identifier. Defaults to 'agy'. */
  provider?: string;
  /** If true, inlines workflow and role definitions into a single file. */
  inline?: boolean;
}

/**
 * Options for starting a workflow Run.
 */
export interface StartOptions {
  /** Target GitHub issue number. */
  issue: number;
  /** Path to configuration file. If omitted, default dot config is used. */
  configPath?: string;
  /** Provider override (e.g. 'agy'). */
  provider?: string;
  /** Explicit shared requirements string. Mutually exclusive with requirementsFile. */
  requirements?: string;
  /** Path to shared requirements file (UTF-8). Mutually exclusive with requirements. */
  requirementsFile?: string;
}

/**
 * Options for querying Run status.
 */
export interface StatusOptions {
  /** Target Run identifier. If omitted, latest run is selected. */
  runId?: string;
  /** Path to configuration file. */
  configPath?: string;
  /** Whether to include detailed events in output. */
  detailed?: boolean;
}

/**
 * Summarized status result reported by the engine.
 */
export interface StatusResult {
  /** Unique identifier of the Run. */
  run_id: string;
  /** GitHub repository (owner/repo). */
  repository: string;
  /** Issue number. */
  issue: number;
  /** Lifecycle status. */
  status: RunStatus;
  /** Active workflow step name. */
  step: string;
  /** Provider identifier. */
  provider: string;
  /** ISO timestamp when Run was created. */
  created_at: string;
  /** Assigned worktree directory path. */
  worktree_path: string;
  /** Number of rework cycles. */
  rework_count: number;
  /** Total count of persisted events in the run's log. */
  events_count: number;
  /** Human-readable status summary. */
  summary: string;
  /** Captured shared requirements. */
  shared_requirements?: string;
}

/**
 * Result of executing preflight checks.
 */
export interface PreflightCheckResult {
  /** Whether all preflight checks passed. */
  ok: boolean;
  /** List of actionable failure messages if ok is false. */
  errors: string[];
  /** Detailed telemetry or context for diagnosis. */
  details?: Record<string, unknown>;
}

/**
 * External interface for inspecting and verifying GitHub issue accessibility.
 */
export interface IssueChecker {
  /**
   * Verifies that the requested issue exists and is accessible.
   * @param repository The repository in owner/repo format.
   * @param issue The issue number.
   */
  checkIssue(repository: string, issue: number): Promise<{
    exists: boolean;
    open?: boolean;
    title?: string;
    error?: string;
  }>;
}

/**
 * External interface for verifying agent execution provider availability.
 */
export interface ProviderChecker {
  /**
   * Verifies that the provider is installed, accessible, and has required capabilities.
   * @param provider The provider identifier (e.g. 'agy').
   */
  check(provider: string): Promise<{
    available: boolean;
    error?: string;
  }>;
}
