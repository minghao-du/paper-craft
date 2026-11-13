/**
 * Workspace core domain types and contracts.
 *
 * Implements Section 6 of WORKSPACE_TYPESCRIPT_REFACTOR_PLAN.md.
 */

// ============================================================================
// Prepare Types (Section 6.1)
// ============================================================================

export type PrepareTarget =
  | { kind: 'issue'; issue: number; branch?: string; path?: string; expectedHead?: string }
  | { kind: 'branch'; branch: string; path: string; expectedHead?: string }
  | { kind: 'detached'; commit: string; path: string };

export interface WorkspaceOverrides {
  deliveryTarget?: string;
  baseRemote?: string;
  pushRemote?: string;
  baseBranch?: string;
  worktreeContainer?: string;
}

export interface PrepareRequest {
  sourceCheckout: string;
  target: PrepareTarget;
  configPath?: string;
  overrides?: WorkspaceOverrides;
  expectedRepository?: string;
}

export interface PreparedWorkspace {
  repository: string;
  deliveryTarget: string;
  sourceCheckout: string;
  path: string;
  branch: string | null;
  commit: string;
  baseBranch: string;
  baseRemote: string;
  pushRemote: string;
  disposition: 'created' | 'reused';
}

export type PreparedWorkspaceResult = {
  outcome: 'prepared' | 'reused';
  repository: string;
  delivery_target: string;
  base_remote: string;
  push_remote: string;
  working_directory: string;
  worktree: string;
  branch: string | null;
  baseBranch: string;
  commit: string;
  created: boolean;
};

// ============================================================================
// Cleanup Types (Section 6.2)
// ============================================================================

export interface PrDeliveryEvidence {
  number: number;
  state: 'MERGED' | 'OPEN' | 'CLOSED' | string;
  merged?: boolean;
  headRepository?: string;
  headBranch?: string;
  headSha?: string;
  baseBranch?: string;
  mergeCommit?: string;
}

export interface OwnershipEvidence {
  rootIssueId?: string | number;
  root_issue_id?: string | number;
  issue?: string | number;
  issueId?: string | number;
  source?: string;
}

export interface TaskBranchCleanupCandidate {
  kind: 'task_branch';
  worktree?: string;
  branch: string;
  commit?: string;
  baseBranch?: string;
  deliveryTarget?: string;
  baseRemote?: string;
  pushRemote?: string;
  pr?: number | string | PrDeliveryEvidence;
  created?: boolean;
  ownershipEvidence?: OwnershipEvidence;
  consumersFinished?: boolean;
}

export interface DetachedCleanupCandidate {
  kind: 'detached';
  worktree: string;
  commit: string;
  baseBranch?: string;
  deliveryTarget?: string;
  baseRemote?: string;
  pushRemote?: string;
  ownershipEvidence?: OwnershipEvidence;
  consumersFinished?: boolean;
  verificationCompleted?: boolean;
}

export type CleanupCandidate = TaskBranchCleanupCandidate | DetachedCleanupCandidate;

export interface ResourceDisposition {
  status: 'removed' | 'already_absent' | 'retained';
  reasonCode?: string;
  reason?: string;
}

export interface CandidateCleanupResult {
  candidate: CleanupCandidate;
  worktree?: ResourceDisposition;
  localBranch?: ResourceDisposition;
  remoteBranch?: ResourceDisposition;
}

export interface CleanupRequest {
  sourceCheckout: string;
  rootIssueId: string;
  candidates: CleanupCandidate[];
  unresolved?: string[];
  protectedPaths: string[];
}

export interface CleanupResult {
  outcome: 'cleaned' | 'incomplete';
  candidates: CandidateCleanupResult[];
  unresolved: string[];
}

// External 4-list contract compatible with Orchestrator/Workflow
export interface ExternalCleanupReport {
  outcome: 'cleaned' | 'incomplete';
  removed_paths: string[];
  retained_paths: Array<{ path: string; reason: string }>;
  removed_branches: Array<{
    branch: string | null;
    scope: 'local' | 'remote';
    remote?: string;
    already_absent?: boolean;
  }>;
  retained_branches: Array<{ branch: string | null; reason: string }>;
}

// ============================================================================
// Error Types (Section 6.3)
// ============================================================================

export type WorkspaceErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIG_INVALID'
  | 'WORKTREE_CONFLICT'
  | 'HEAD_MISMATCH'
  | 'COMMAND_FAILED'
  | 'UNCLEAN_CHECKOUT'
  | 'REPOSITORY_NOT_FOUND'
  | 'PROTECTED_RESOURCE'
  | 'VERIFICATION_FAILED';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: WorkspaceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, WorkspaceError.prototype);
  }
}
