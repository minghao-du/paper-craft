/**
 * Workflow types and interfaces.
 * Workflow module owns workflow definition, validation, canonical stage resolution,
 * delivery sequences, attempts/replan budgets, and completion policy verification.
 */

export type CompletionPolicy = "issue_delivery" | "basic";

export interface SkillProvider {
  type: "skill";
  target: string;
  args?: string[];
}

export interface PlanningSource {
  dispatch_id: string;
  issue_id?: string;
  stage: string;
  step_index: number;
  execution_status: string;
  provider?: SkillProvider;
  result: Record<string, unknown>;
  receipt_path: string;
}

export interface WorkflowStage {
  id: string;
  logical_task?: string;
  name?: string;
  auxiliary?: boolean;
  replan?: boolean;
  provider?: SkillProvider;
  description?: string;
  template?: string;
  receipt_template?: string;
  scope?: string;
  parameters?: Record<string, unknown>;
  configs?: Record<string, unknown>;
  depends_on?: string | string[];
  dependencies?: string | string[];
  next?: string;
  on_success?: string;
  on_failure?: string;
  next_stage?: string;
  [key: string]: unknown;
}

export interface WorkflowDefinition {
  name: string;
  version?: string;
  initial_stage?: string;
  completion_policy: CompletionPolicy;
  target?: string;
  description?: string;
  stages: WorkflowStage[];
  [key: string]: unknown;
}

export interface IssueBudgets {
  delivery_attempts_used: number;
  delivery_attempts_max: number;
  replans_used?: number;
  replans_max?: number;
  replans_by_stage?: Record<string, number>;
  [key: string]: unknown;
}

export type WorkflowBudgets = IssueBudgets;

export interface LandingEvidence {
  dispatch_id: string;
  receipt_path: string;
  delivery_attempt: number;
  [key: string]: unknown;
}

export interface DeliveryItem {
  issue_id: string;
  stage: string;
  status: string;
  budgets: IssueBudgets;
  landed: boolean;
  land_receipt_path?: string;
  land_dispatch_id?: string;
  landed_attempt?: number;
  [key: string]: unknown;
}

export interface DeliverySequence {
  items: DeliveryItem[];
  current_index: number;
  completed: boolean;
  active_rework_issue_id?: string | null;
  [key: string]: unknown;
}

export interface DeliveryState {
  rootIssueId: string;
  currentIssueId: string;
  rootBudgets: IssueBudgets;
  sequence?: DeliverySequence;
  rootLandingEvidence?: LandingEvidence;
}

export interface TaskBudgetView {
  delivery_attempts_used: number;
  delivery_attempts_max: number;
  replans_used: number;
  replans_max: number;
  replans_by_stage?: Record<string, number>;
}

export interface EvaluatedTask {
  stage: string; // canonical ID
  logicalTask: string;
  provider: SkillProvider;
  auxiliary: boolean;
  replan: boolean;
  issueId: string;
  attempt: number; // envelope attempt count
  deliveryAttempt: number; // delivery round, distinct from replan attempt
  originatingStage?: string;
  receiptTemplate: string;
  scope: string;
  parameters: Record<string, unknown>;
  budgets: TaskBudgetView;
}

export interface DispatchEvaluation {
  task: EvaluatedTask;
  nextDeliveryState: DeliveryState;
}

export interface CompletionRecordView {
  dispatch_id?: string;
  step_index?: number;
  stage?: string;
  attempt?: number;
  delivery_attempt?: number;
  originating_stage?: string;
  issue_id?: string;
  execution_status?: string;
  result?: Record<string, unknown>;
  receipt_path?: string;
  provider?: SkillProvider;
  [key: string]: unknown;
}

export interface EvaluateDispatchParams {
  workflow: WorkflowDefinition;
  deliveryState: DeliveryState;
  request: {
    stage: string;
    objective?: string;
    provider?: SkillProvider;
    scope?: string;
    parameters?: Record<string, unknown>;
    receipt_template?: string;
    attempt_intent?: "same" | "new";
    rework_issue?: string | null;
    originating_stage?: string;
  };
  environmentDefaults?: {
    delivery_target?: string;
    base_remote?: string;
    push_remote?: string;
    worktree_container?: string;
  };
  completedStages?: readonly CompletionRecordView[];
}

export type DeliveryDecision =
  | {
      kind: "accept_plan";
      planDispatchId: string;
      nextStage: string;
    }
  | {
      kind: "update_delivery";
      nextStage?: string;
      currentIssueId?: string;
      landing?: { issueId: string; dispatchId: string };
      completeSequence?: boolean;
    };

export interface ApplyDeliveryDecisionParams {
  workflow: WorkflowDefinition;
  deliveryState?: DeliveryState;
  decision?: string | DeliveryDecision;
  completedStages?: readonly CompletionRecordView[];
  // Legacy compatibility fields during refactoring:
  deliverySequence?: DeliverySequence | null;
  budgets?: WorkflowBudgets;
  currentIssueId?: string;
  rootIssueId?: string;
  action?: string;
  nextStage?: string | null;
  planningSource?: PlanningSource;
  currentIssue?: string | null;
  markLanded?: string | null;
  landingDispatchId?: string | null;
  completeSequence?: boolean;
}

export interface DeliveryDecisionResult {
  nextDeliveryState: DeliveryState;
  nextStage?: string;
  // Legacy compatibility:
  deliverySequence?: DeliverySequence;
  currentIssueId: string;
  budgets: WorkflowBudgets;
}

export type ApplyDeliveryDecisionResult = DeliveryDecisionResult;

export interface AssertCanFinishParams {
  workflow: WorkflowDefinition;
  deliveryState?: DeliveryState;
  completedStages: readonly CompletionRecordView[];
  rootIssueId: string;
  // Legacy compatibility:
  activeDispatch?: { dispatch_id?: string; [key: string]: unknown } | null;
  protocolError?: { message?: string; [key: string]: unknown } | null;
}

export interface InspectDeliveryParams {
  workflow: WorkflowDefinition;
  deliveryState: DeliveryState;
  completedStages?: readonly CompletionRecordView[];
}

export interface DeliveryInspection {
  currentIssueId: string;
  activeReworkIssueId?: string | null;
  budgets: TaskBudgetView;
  blockingReasons: string[];
  reworkNeeded: boolean;
  sequenceCompleted: boolean;
  canFinish: boolean;
}

// Legacy helpers & compatibility types
export interface TaskIntent {
  canonical_stage: string;
  stage_def: WorkflowStage;
  provider: {
    type: "skill";
    target: string;
    args: string[];
  };
  auxiliary: boolean;
  replan: boolean;
  template: string;
  scope: string;
  parameters: Record<string, unknown>;
}

export interface DeliveryCalculationResult {
  current_issue_id: string;
  attempt: number;
  delivery_attempts_used: number;
  delivery_attempts_max: number;
  replan_attempts_used: number;
  replan_attempts_max: number;
  budgets: WorkflowBudgets;
  delivery_sequence?: DeliverySequence;
  originating_stage_for_replan?: string | null;
}

export interface ProviderOverride {
  type?: string;
  target?: string;
  args?: string[];
}

export interface ResolveTaskIntentOptions {
  template?: string;
  scope?: string;
  parameters?: Record<string, unknown>;
  configSnapshot?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface CalculateDeliveryChangeParams {
  intent: TaskIntent;
  deliverySequence?: DeliverySequence | null;
  budgets: WorkflowBudgets;
  currentIssueId: string;
  rootIssueId: string;
  reworkIssue?: string | null;
  attemptIntent?: "same" | "new";
  originatingStageForReplan?: string | null;
  parameters?: Record<string, unknown>;
}
