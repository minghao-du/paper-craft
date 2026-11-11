import type { Data } from "./workflow.js";
/** Persistent protocol types shared across the skill's deterministic operations. */
export interface SkillProvider {
  type: "skill";
  target: string;
  args: string[];
}
export interface Budgets {
  delivery_attempts_used: number;
  delivery_attempts_max: number;
  replans_used: number;
  replans_max: number;
}
export interface DispatchRequest {
  objective: string;
  provider: SkillProvider;
  logical_stage: string;
  acceptance_criteria: string[];
  predecessors: string[];
  working_directory: string;
  branch: string | null;
  commit: string | null;
}
export interface Dispatch {
  dispatch_id: string;
  step_index: number;
  task_name: string;
  attempt: number;
  status: "prepared" | "handed_off" | "running";
  authorized: boolean;
  envelope_path: string;
  receipt_path: string;
  request: DispatchRequest;
  platform_handle?: string;
  handed_off_at?: string;
}
export interface CompactReport {
  execution_status: "succeeded" | "failed" | "blocked";
  result: Record<string, unknown>;
  receipt_path: string;
  summary: string;
  dispatch_id?: string;
}
export interface Completion {
  dispatch_id: string;
  step_index: number;
  stage: string;
  attempt: number;
  execution_status: CompactReport["execution_status"];
  result: Record<string, unknown>;
  receipt_path: string;
  summary: string;
  completed_at: string;
}
export interface ProtocolError {
  error_type: string;
  message: string;
  timestamp: string;
}

export interface RuntimeState extends Data {
  schema_version: string;
  root_issue_id: string;
  current_issue_id: string;
  current_stage: string;
  stage_status: string;
  next_step_index: number;
  active_dispatch: (Dispatch & Data) | null;
  completed_stages: (Completion & Data)[];
  decisions: Data[];
  budgets: Budgets & Data;
  protocol_error?: ProtocolError | null;
  context: Data;
  config_snapshot: Data;
  workflow_snapshot: Data;
  last_updated: string;
}
