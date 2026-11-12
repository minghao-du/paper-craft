/**
 * Lifecycle types and interfaces.
 * Lifecycle module owns dispatch authorization, report correlation, envelope protocol,
 * and operation orchestration.
 */

import type {
  WorkflowBudgets,
  WorkflowDefinition,
  DeliverySequence,
  SkillProvider,
  LandingEvidence,
} from "../workflow/types.js";

export type { SkillProvider, LandingEvidence };

export interface NormalizedDispatchRequest {
  request_id: string;
  stage: string;
  objective: string;
  provider?: {
    type: "skill";
    target: string;
    args: string[];
  };
  acceptance_criteria: string[];
  predecessor_receipts: string[];
  workdir?: string;
  branch?: string | null;
  commit?: string | null;
  scope: string;
  parameters: Record<string, unknown>;
  receipt_template?: string;
  attempt_intent: "same" | "new";
  rework_issue: string | null;
}

export interface Dispatch {
  dispatch_id: string;
  step_index: number;
  task_name: string;
  issue_id?: string;
  attempt: number;
  delivery_attempt?: number;
  originating_stage?: string;
  status: "prepared" | "handed_off" | "running";
  authorized: boolean;
  envelope_path: string;
  receipt_path: string;
  // Older runs have no request identity or independently stored resolved provider.
  request?: NormalizedDispatchRequest;
  provider?: SkillProvider;
  [key: string]: unknown;
}

export type { CompactReport, ExecutionStatus, TaskInputEnvelope } from "../protocol/index.js";
import type { ExecutionStatus } from "../protocol/index.js";

export interface Completion {
  dispatch_id: string;
  step_index: number;
  stage: string;
  attempt: number;
  delivery_attempt?: number;
  originating_stage?: string;
  /** Issue the dispatch worked on; taken from the active dispatch, not mutable current_issue_id. */
  issue_id?: string;
  execution_status: ExecutionStatus;
  result: Record<string, unknown>;
  receipt_path: string;
  summary: string;
  completed_at: string;
  request?: NormalizedDispatchRequest;
  provider?: SkillProvider;
  envelope_path?: string;
  [key: string]: unknown;
}

export type CompletedDispatch = Completion;

export interface ProtocolError {
  error_type: string;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface DecisionRecord {
  decision: string;
  action: string;
  reason: string;
  options?: string[];
  next_stage?: string;
  plan_dispatch_id?: string;
  current_issue?: string;
  mark_landed?: string;
  landing_dispatch_id?: string | null;
  complete_sequence?: boolean;
  timestamp: string;
  [key: string]: unknown;
}

export interface RuntimeState {
  schema_version: string;
  root_issue_id: string;
  current_issue_id: string;
  workflow?: string;
  workflow_snapshot: WorkflowDefinition;
  current_stage: string;
  stage_status: string;
  next_step_index: number;
  active_dispatch: Dispatch | null;
  completed_stages: Completion[];
  decisions: DecisionRecord[];
  budgets: WorkflowBudgets;
  delivery_sequence?: DeliverySequence;
  pending_stage_selection?: null | {
    stage: string;
    decision_index: number;
  };
  root_landing_evidence?: LandingEvidence;
  protocol_error?: ProtocolError | null;
  orchestrator_decision?: string;
  originating_stage_for_replan?: string | null;
  context: Record<string, unknown>;
  config_snapshot: Record<string, unknown>;
  last_updated: string;
  [key: string]: unknown;
}

export interface InitOptions {
  root_issue: string | number;
  receipt_root?: string;
  repo_dir?: string;
  workflow?: string;
  force?: boolean;
  require_config?: boolean;
  delivery_attempts_max?: number;
  replans_max?: number;
  delivery_target?: string;
  base_remote?: string;
  push_remote?: string;
  base_branch?: string;
  worktree_container?: string;
  [key: string]: unknown;
}

export interface DispatchOptions {
  receipt_root: string;
  request_id: string;
  stage: string;
  objective: string;
  provider?: {
    type: "skill";
    target: string;
    args?: string[];
  };
  provider_type?: "skill";
  provider_target?: string;
  provider_args?: string[];
  acceptance_criteria?: string[];
  predecessor_receipts?: string[];
  workdir?: string;
  scope?: string;
  parameters?: Record<string, unknown>;
  attempt_intent?: "same" | "new";
  branch?: string | null;
  commit?: string | null;
  receipt_template?: string;
  rework_issue?: string | number | null;
  [key: string]: unknown;
}

interface DispatchResultFields {
  dispatch_id: string;
  step_index: number;
  envelope_path: string;
  receipt_path: string;
  attempt: number;
  stage: string;
  provider: SkillProvider;
}

export type DispatchResult = DispatchResultFields &
  (
    | { status: "handed_off" | "running"; launch_granted: boolean }
    | { status: "completed"; launch_granted: false; completion: CompletedDispatch }
  );

export interface CompleteOptions {
  receipt_root: string;
  dispatch_id: string;
  report: unknown;
}

export interface ResolveOptions {
  receipt_root: string;
  decision: "wait_user" | "continue" | "halt" | "finish";
  reason: string;
  options?: string[];
  next_stage?: string | null;
  plan_dispatch_id?: string;
  current_issue?: string | number | null;
  mark_landed?: string | number | null;
  /** Dispatch id of the completed pc-pr-land record that proves mark_landed. */
  landing_dispatch_id?: string | null;
  complete_sequence?: boolean;
  [key: string]: unknown;
}

export interface InspectOptions {
  receipt_root: string;
  field?: string;
}

export interface EnvelopeCreateOptions {
  schema_version?: string;
  task: {
    logical_stage: string;
    step_index: number;
    attempt?: number;
    root_issue_id: string;
    current_issue_id?: string;
  };
  provider: {
    type?: string;
    target: string;
    args?: string[];
  };
  environment: {
    working_directory: string;
    repository: string;
    base_branch?: string;
    branch?: string | null;
    commit?: string | null;
  };
  inputs: {
    objective: string;
    scope?: string;
    acceptance_criteria?: string[];
    predecessor_receipts?: string[];
    parameters?: Record<string, unknown>;
  };
  contract: {
    receipt_path: string;
    receipt_template?: string;
  };
  budgets: {
    delivery_attempts_used?: number;
    delivery_attempts_max?: number;
    replans_used?: number;
    replans_max?: number;
  };
  validate?: boolean;
}
