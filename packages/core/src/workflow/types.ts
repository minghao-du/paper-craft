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
  /** Optional input artifact or context references expected for this step. */
  input_artifacts?: string[];
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
export type RunStatus = 'pending_dispatch' | 'running' | 'completed' | 'blocked' | 'paused' | 'uncertain';

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
  /** Optional execution handle representing an active orchestrator session. */
  orchestratorHandle?: ExecutionHandle;
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
  /** Detailed active task information if any task was dispatched. */
  active_task?: StatusActiveTask;
}

/**
 * Detailed active task information embedded in StatusResult.
 */
export interface StatusActiveTask {
  /** Active or last dispatched task ID. */
  task_id: string;
  /** Step name for the task. */
  step: string;
  /** Assigned role. */
  role: string;
  /** Associated execution handle. */
  handle?: ExecutionHandle;
  /** Process/session execution status from provider. */
  execution_status?: ExecutionStatus;
  /** Exit code if the process exited. */
  exit_code?: number;
  /** Diagnostic error or failure message if uncertain or errored. */
  error?: string;
  /** Business result outcome if submitted. */
  business_outcome?: string;
  /** Submitted task result if available. */
  result?: TaskResult;
  /** Whether execution termination has been verified. */
  stopped?: boolean;
}

/**
 * Opaque handle returned by an agent executor representing a launched task.
 */
export interface ExecutionHandle {
  /** Provider-specific execution identifier (e.g. process PID, session ID, conversation ID). */
  id: string;
  /** Stable task identifier bound to the workflow attempt. */
  taskId: string;
}

/**
 * Status of the agent execution process or session.
 */
export type ExecutionStatus = 'not_started' | 'running' | 'exited' | 'uncertain';

/**
 * Result of inspecting an agent execution process by its stable taskId.
 */
export interface ExecutionInspection {
  /** Current process or session execution status. */
  status: ExecutionStatus;
  /** Associated execution handle if started. */
  handle?: ExecutionHandle;
  /** Exit code if the process exited. */
  exitCode?: number;
  /** Failure or diagnostic message if uncertain or errored. */
  error?: string;
}

/**
 * Result of stopping an agent execution.
 */
export interface ExecutionStopResult {
  /** Whether the process was successfully stopped. */
  stopped: boolean;
  /** Whether the stop outcome is uncertain. */
  uncertain?: boolean;
  /** Failure or diagnostic message if termination failed. */
  error?: string;
}

/**
 * Provider-independent contract for agent execution.
 */
export interface AgentExecutor {
  /** Verifies availability and readiness of the execution provider. */
  check(): Promise<{ available: boolean; error?: string }>;
  /** Launches an agent task in the target working directory with the given prompt. */
  launch(taskId: string, workingDirectory: string, prompt: string): Promise<ExecutionHandle>;
  /** Inspects the execution state by its stable task identifier. */
  inspect(taskId: string): Promise<ExecutionInspection>;
  /** Sends a message to a running agent execution. */
  send(handle: ExecutionHandle, message: string): Promise<void>;
  /** Stops a running agent execution and verifies termination. */
  stop(handle: ExecutionHandle): Promise<ExecutionStopResult>;
}

/**
 * Prior evidence and review findings carried forward into subsequent steps (e.g. rework).
 */
export interface PriorEvidence {
  /** The specific git commit SHA evaluated during review. */
  evaluatedCommit?: string;
  /** Detailed review findings, defect notes, or repair guidance. */
  findings?: string;
  /** Task ID that produced this prior evidence. */
  priorTaskId?: string;
  /** Step where this prior evidence was generated. */
  priorStep?: string;
  /** Role that produced this prior evidence. */
  priorRole?: string;
  /** Outcome submitted by the prior task. */
  priorOutcome?: string;
  /** Summary of work performed by the prior task. */
  priorSummary?: string;
  /** Raw artifacts dictionary from the prior task. */
  artifacts?: Record<string, unknown>;
}

/**
 * Result of computing the next workflow step from a step outcome.
 */
export interface StepTransitionResult {
  /** The next workflow step name, or undefined if terminal or paused. */
  nextStep?: string;
  /** Resulting lifecycle status of the Run. */
  status: RunStatus;
  /** Whether the transition reached a terminal or paused state (completed, blocked, paused). */
  isTerminal: boolean;
  /** Whether this transition represents a rework cycle. */
  isRework: boolean;
  /** Current or updated rework count. */
  reworkCount: number;
  /** Human-readable explanation of the transition. */
  reason: string;
}

/**
 * Complete scheduling context supplied by the Engine to an orchestrator.
 */
export interface SchedulingContext {
  /** Run identifier. */
  runId: string;
  /** Repository in owner/repo format. */
  repository: string;
  /** Target issue number. */
  issue: number;
  /** Current lifecycle status. */
  status: RunStatus;
  /** Current workflow step. */
  currentStep: string;
  /** Number of rework loops completed. */
  reworkCount: number;
  /** Maximum rework loops allowed. */
  reworkLimit: number;
  /** Provider identifier. */
  provider: string;
  /** Path to the assigned worktree. */
  worktreePath: string;
  /** Step definition for the current step. */
  stepDefinition: WorkflowStep;
  /** Role contract for the current step. */
  roleContract: RoleContract;
  /** Immutable shared requirements for the Run. */
  sharedRequirements: string;
  /** Active task ID if one is currently in flight or dispatched. */
  activeTaskId?: string;
  /** Active execution handle if launched. */
  activeHandle?: ExecutionHandle;
  /** Latest submitted task result if available. */
  latestResult?: TaskResult;
  /** Prior evidence and review findings carried forward from preceding steps. */
  priorEvidence?: PriorEvidence;
  /** Evaluated commit SHA from review if available. */
  evaluatedCommit?: string;
  /** Usable review findings if available. */
  reviewFindings?: string;
  /** Confirmed merged commit SHA from merge step if available. */
  mergedCommit?: string;
  /** Accumulated delivery artifacts from prior workflow steps (diff, test results, review, merge). */
  deliveryArtifacts?: Record<string, unknown>;
}

/**
 * Options for dispatching a task to a specialist role.
 */
export interface DispatchOptions {
  /** Optional task-specific input references or metadata. */
  inputs?: Record<string, unknown>;
  /** Custom task identifier override (optional; Engine generates one by default). */
  taskId?: string;
}

/**
 * Result returned upon successful task dispatch.
 */
export interface DispatchResult {
  /** Unique stable task identifier. */
  taskId: string;
  /** Provider execution handle. */
  handle: ExecutionHandle;
  /** Active workflow step name. */
  step: string;
  /** Specialist role name. */
  role: string;
  /** Dedicated worktree path. */
  worktreePath: string;
}

/**
 * Structured result submitted by a specialist role.
 */
export interface TaskResult {
  /** Submitted outcome string (must match permitted_outcomes in RoleContract). */
  outcome: string;
  /** High-level summary of work performed. */
  summary: string;
  /** Artifacts produced by the task (must satisfy required_artifacts in RoleContract). */
  artifacts?: Record<string, unknown>;
}

/**
 * Response acknowledging a validated task result submission.
 */
export interface SubmitResultResponse {
  /** Whether the submission was acknowledged. */
  acknowledged: boolean;
  /** Task identifier bound to the result. */
  taskId: string;
  /** Run identifier. */
  runId: string;
  /** Workflow step at the time of submission. */
  step: string;
  /** Submitted outcome. */
  outcome: string;
  /** Summary of the result. */
  summary: string;
  /** Captured artifacts. */
  artifacts: Record<string, unknown>;
  /** Whether execution termination was verified. */
  executionTerminated: boolean;
  /** True if this was an idempotent resubmission of an identical result. */
  idempotent?: boolean;
  /** Human-readable status message. */
  message?: string;
  /** Target step name transitioned to, if any. */
  nextStep?: string;
  /** Specialist role assigned to the next step, if any. */
  nextRole?: string;
  /** Run status following the step transition. */
  transitionStatus?: RunStatus;
  /** Updated rework count. */
  reworkCount?: number;
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
 * Result of inspecting a GitHub issue.
 */
export interface IssueCheckResult {
  /** Whether the issue exists and is accessible. */
  exists: boolean;
  /** Whether the issue is currently in an open state. */
  open?: boolean;
  /** Title of the issue. */
  title?: string;
  /** Diagnostic error or failure message if inspection failed. */
  error?: string;
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

/**
 * Result of inspecting pull request head and merge state on GitHub.
 */
export interface MergeStatusResult {
  /** Whether the pull request was found/resolved. */
  exists: boolean;
  /** Current head commit SHA of the pull request branch. */
  headSha?: string;
  /** Pull request lifecycle state on GitHub (e.g. 'OPEN', 'MERGED', 'CLOSED'). */
  state?: 'OPEN' | 'MERGED' | 'CLOSED';
  /** Whether the pull request is confirmed merged on GitHub. */
  merged?: boolean;
  /** Commit SHA resulting from the merge on the target branch, if merged. */
  mergeCommitSha?: string;
  /** Diagnostic error or failure message if inspection failed or was uncertain. */
  error?: string;
  /** Whether headSha matches the expected head commit SHA (if evaluated). */
  matchesExpectedHead?: boolean;
}

/**
 * Options for resuming a previously started workflow Run.
 */
export interface ResumeOptions {
  /** Target Run identifier. If omitted, latest run is selected. */
  runId?: string;
  /** Path to workflow configuration file. */
  configPath?: string;
}

/**
 * Action taken by the engine during execution reconciliation on resume.
 */
export type ReconciliationAction = 'reconnected' | 'collected' | 'uncertain' | 'none';

/**
 * Information regarding the active task reconciled during workflow resume.
 */
export interface ReconciledTask {
  /** Stable task identifier bound to the workflow attempt. */
  taskId: string;
  /** Workflow step name for the task. */
  step: string;
  /** Specialist role assigned to the task. */
  role: string;
  /** Provider execution handle if known or recovered. */
  handle?: ExecutionHandle;
  /** Process/session execution status from provider inspection. */
  executionStatus: ExecutionStatus;
  /** Action taken by the engine during reconciliation. */
  action: ReconciliationAction;
  /** Diagnostic error or message if uncertain or failed. */
  error?: string;
  /** Submitted task result if available or collected. */
  result?: TaskResult;
}

/**
 * Result returned upon resuming an interrupted workflow Run.
 */
export interface ResumeResult {
  /** Unique Run identifier. */
  runId: string;
  /** Target GitHub repository (owner/repo). */
  repository: string;
  /** Target GitHub issue number. */
  issue: number;
  /** Lifecycle status after reconciliation. */
  status: RunStatus;
  /** Active workflow step name. */
  currentStep: string;
  /** Assigned physical worktree directory path. */
  worktreePath: string;
  /** Restored scheduling context for the orchestrator. */
  schedulingContext: SchedulingContext;
  /** Reconciled active task details if a task was in flight or dispatched. */
  reconciledTask?: ReconciledTask;
  /** Total count of persisted events in the run's log. */
  eventsCount: number;
  /** Human-readable explanation of resume and reconciliation outcome. */
  message: string;
}

/**
 * Options for releasing Run resources.
 */
export interface ReleaseResourcesOptions {
  /** Task ID triggering the release. */
  taskId?: string;
  /** Summary of work performed before release. */
  summary?: string;
  /** Artifacts produced by the finalizer task. */
  artifacts?: Record<string, unknown>;
}

/**
 * Result of releasing Run resources and verifying completion.
 */
export interface ReleaseResourcesResult {
  /** Unique identifier of the Run. */
  runId: string;
  /** Whether all resources were cleanly released and all executions verified terminated. */
  released: boolean;
  /** Whether the worktree was deleted. */
  worktreeRemoved: boolean;
  /** Path to the worktree that was verified and removed. */
  worktreePath?: string;
  /** List of execution handles verified terminated during release. */
  terminatedHandles: ExecutionHandle[];
  /** Resulting lifecycle status of the Run (completed or blocked). */
  status: RunStatus;
  /** Human-readable explanation. */
  message: string;
  /** Error or diagnostic details if release failed. */
  error?: string;
}

/**
 * Options for stopping active executions and pausing a workflow Run.
 */
export interface StopRunOptions {
  /** Target Run identifier. If omitted, latest run is selected. */
  runId?: string;
  /** Path to workflow configuration file. */
  configPath?: string;
  /** Reason for stopping the Run. */
  reason?: string;
}

/**
 * Result of stopping active executions and pausing a workflow Run.
 */
export interface StopRunResult {
  /** Unique Run identifier. */
  runId: string;
  /** Whether active executions were stopped and verified terminated. */
  stopped: boolean;
  /** List of execution handles verified terminated during stop. */
  terminatedHandles: ExecutionHandle[];
  /** Resulting lifecycle status of the Run. */
  status: RunStatus;
  /** Human-readable explanation. */
  message: string;
  /** Error or diagnostic details if stopping failed. */
  error?: string;
}

