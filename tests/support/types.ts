/**
 * TaskInputEnvelope contract definition matching envelope-cli.ts schema.
 */
export interface TaskInputEnvelope {
  schema_version: string;
  task: {
    logical_stage: string;
    step_index: number;
    attempt: number;
    root_issue_id: string;
    current_issue_id: string;
  };
  provider: {
    type: 'skill';
    target: string;
    args: string[];
  };
  environment: {
    working_directory: string;
    repository: string;
    base_branch: string;
    branch?: string | null;
    commit?: string | null;
  };
  inputs: {
    objective: string;
    scope?: string;
    acceptance_criteria: string[];
    predecessor_receipts: string[];
    parameters?: Record<string, unknown>;
  };
  contract: {
    receipt_path: string;
    receipt_template: string;
  };
  budgets: {
    delivery_attempts_used: number;
    delivery_attempts_max: number;
    replans_used: number;
    replans_max: number;
  };
}

/**
 * Unified Compact Receipt Report contract definition.
 */
export interface CompactReceiptReport {
  execution_status: 'succeeded' | 'blocked' | 'failed';
  result: Record<string, unknown>;
  receipt_path: string;
  summary: string;
}
