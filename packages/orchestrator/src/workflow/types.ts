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

export interface WorkflowBudgets {
  delivery_attempts_used: number;
  delivery_attempts_max: number;
  replans_used: number;
  replans_max: number;
  replans_by_stage?: Record<string, number>;
  [key: string]: unknown;
}

export interface DeliveryItem {
  issue_id: string;
  stage: string;
  status: string;
  budgets: {
    delivery_attempts_used: number;
    delivery_attempts_max: number;
    replans_used?: number;
    replans_max?: number;
    replans_by_stage?: Record<string, number>;
    [key: string]: unknown;
  };
  landed: boolean;
  land_receipt_path?: string;
  land_dispatch_id?: string;
  [key: string]: unknown;
}

export interface DeliverySequence {
  items: DeliveryItem[];
  current_index: number;
  completed: boolean;
  active_rework_issue_id?: string | null;
  [key: string]: unknown;
}

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

export interface ApplyDeliveryDecisionParams {
  deliverySequence?: DeliverySequence | null;
  budgets: WorkflowBudgets;
  currentIssueId: string;
  rootIssueId: string;
  decision: string;
  action: string;
  nextStage?: string | null;
  childIssues?: string[] | null;
  plan?: unknown;
  currentIssue?: string | null;
  markLanded?: string | null;
  landingDispatchId?: string | null;
  completeSequence?: boolean;
  workflow: WorkflowDefinition;
  completedStages?: Array<{
    dispatch_id?: string;
    issue_id?: string;
    stage?: string;
    execution_status?: string;
    result?: Record<string, unknown>;
    receipt_path?: string;
    step_index?: number;
    [key: string]: unknown;
  }>;
}

export interface ApplyDeliveryDecisionResult {
  deliverySequence?: DeliverySequence;
  currentIssueId: string;
  budgets: WorkflowBudgets;
}

export interface AssertCanFinishParams {
  workflow: WorkflowDefinition;
  completedStages: Array<{
    stage?: string;
    execution_status?: string;
    step_index?: number;
    result?: Record<string, unknown>;
    receipt_path?: string;
    [key: string]: unknown;
  }>;
  activeDispatch?: { dispatch_id?: string; [key: string]: unknown } | null;
  protocolError?: { message?: string; [key: string]: unknown } | null;
  rootIssueId: string;
}
