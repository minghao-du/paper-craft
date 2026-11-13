/**
 * Workspace cleanup core implementation.
 *
 * Implements Section 6.2 and Phase 11 C of WORKSPACE_TYPESCRIPT_REFACTOR_PLAN.md.
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  checkRefFormat,
  fetchRef,
  findPrimaryCheckout,
  findRepoRoot,
  getGitCommonDir,
  getHeadCommit,
  getRemoteUrl,
  isAncestor,
  isClean,
  isParentDir,
  isValidCommitSha,
  listWorktrees,
  removeBranchConfig,
  removeWorktree,
  resolvePath,
  runGit,
  updateRefDelete,
  type WorktreeEntry,
} from './git.js';
import {
  type CandidateCleanupResult,
  type CleanupCandidate,
  type CleanupRequest,
  type CleanupResult,
  type DetachedCleanupCandidate,
  type OwnershipEvidence,
  type PrDeliveryEvidence,
  type TaskBranchCleanupCandidate,
  WorkspaceError,
} from './types.js';

export interface CleanupOptions {
  ghRunner?: (args: string[], cwd: string) => string;
}

interface PrViewPayload {
  state?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  mergeCommit?: { oid?: string } | string;
  headRepository?: { name?: string; owner?: { login?: string } } | string;
  headRepositoryOwner?: { login?: string };
}

interface RepoViewPayload {
  nameWithOwner?: string;
  defaultBranchRef?: { name?: string };
}

/**
 * Default GitHub CLI runner calling system `gh`.
 */
function defaultGhRunner(args: string[], cwd: string): string {
  const result = spawnSync('gh', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    const msg = result.stderr || result.stdout || `gh ${args.join(' ')} exited with code ${result.status}`;
    throw new Error(msg.trim());
  }
  return result.stdout.trim();
}

/**
 * Validate explicit kind and strict boolean/structural types for a cleanup candidate.
 */
export function validateCleanupCandidate(
  candidate: unknown,
  idx = 0,
): CleanupCandidate {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new WorkspaceError('INVALID_INPUT', `Candidate at index ${idx} must be an object.`);
  }

  const c = candidate as Record<string, unknown>;

  if (c.kind !== 'task_branch' && c.kind !== 'detached') {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Candidate at index ${idx} must have explicit kind 'task_branch' or 'detached', received '${String(c.kind)}'.`,
    );
  }

  // Strict boolean validation helper
  const checkStrictBool = (val: unknown, name: string) => {
    if (val !== undefined && typeof val !== 'boolean') {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} field '${name}' must be a boolean or omitted; received ${
          val === null ? 'null' : typeof val
        } (${JSON.stringify(val)}).`,
      );
    }
  };

  checkStrictBool(c.created, 'created');
  checkStrictBool(c.consumersFinished, 'consumersFinished');
  checkStrictBool(c.consumers_finished, 'consumers_finished');
  checkStrictBool(c.verificationCompleted, 'verificationCompleted');
  checkStrictBool(c.verification_completed, 'verification_completed');

  // String property type validation helper
  const checkOptionalString = (val: unknown, name: string) => {
    if (val !== undefined && typeof val !== 'string') {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} field '${name}' must be a string if provided; received ${typeof val}.`,
      );
    }
  };

  checkOptionalString(c.worktree, 'worktree');
  checkOptionalString(c.commit, 'commit');
  checkOptionalString(c.baseBranch, 'baseBranch');
  checkOptionalString(c.base_branch, 'base_branch');
  checkOptionalString(c.deliveryTarget, 'deliveryTarget');
  checkOptionalString(c.delivery_target, 'delivery_target');
  checkOptionalString(c.baseRemote, 'baseRemote');
  checkOptionalString(c.base_remote, 'base_remote');
  checkOptionalString(c.pushRemote, 'pushRemote');
  checkOptionalString(c.push_remote, 'push_remote');

  // Ownership evidence validation (non-object is malformed; missing/empty object is retained later)
  const ev = c.ownershipEvidence ?? c.ownership_evidence;
  if (ev !== undefined) {
    if (typeof ev !== 'object' || ev === null || Array.isArray(ev)) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} 'ownershipEvidence' must be an object if provided; received ${
          ev === null ? 'null' : typeof ev
        }.`,
      );
    }
    const evRecord = ev as Record<string, unknown>;
    const rootIssue = evRecord.rootIssueId ?? evRecord.root_issue_id;
    const issue = evRecord.issue ?? evRecord.issue_id ?? evRecord.issueId;
    const source = evRecord.source;

    if (rootIssue !== undefined && typeof rootIssue !== 'string' && typeof rootIssue !== 'number') {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} ownership evidence 'rootIssueId' must be a string or number.`,
      );
    }
    if (issue !== undefined && typeof issue !== 'string' && typeof issue !== 'number') {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} ownership evidence 'issue' must be a string or number.`,
      );
    }
    if (source !== undefined && typeof source !== 'string') {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} ownership evidence 'source' must be a string.`,
      );
    }
  }

  if (c.kind === 'task_branch') {
    if (typeof c.branch !== 'string' || !c.branch.trim()) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} with kind 'task_branch' requires a non-empty string 'branch'.`,
      );
    }
    if (c.verificationCompleted !== undefined || c.verification_completed !== undefined) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} with kind 'task_branch' cannot specify 'verificationCompleted'.`,
      );
    }
    if (c.pr !== undefined && c.pr !== null) {
      if (typeof c.pr !== 'number' && typeof c.pr !== 'string') {
        if (typeof c.pr !== 'object' || Array.isArray(c.pr)) {
          throw new WorkspaceError(
            'INVALID_INPUT',
            `Candidate at index ${idx} 'pr' must be a number, string, or PR delivery evidence object.`,
          );
        }
      }
    }
    return candidate as TaskBranchCleanupCandidate;
  }

  // c.kind === 'detached'
  if (typeof c.worktree !== 'string' || !c.worktree.trim()) {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Candidate at index ${idx} with kind 'detached' requires a non-empty string 'worktree'.`,
    );
  }
  if (typeof c.commit !== 'string' || !c.commit.trim()) {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Candidate at index ${idx} with kind 'detached' requires a non-empty string 'commit'.`,
    );
  }
  if (c.branch !== undefined) {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Candidate at index ${idx} with kind 'detached' cannot specify a 'branch'.`,
    );
  }
  if (c.created !== undefined) {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Candidate at index ${idx} with kind 'detached' cannot specify 'created'.`,
    );
  }
  if (c.pr !== undefined) {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Candidate at index ${idx} with kind 'detached' cannot specify 'pr'.`,
    );
  }

  return candidate as DetachedCleanupCandidate;
}

/**
 * Validate root cleanup request structure.
 */
function validateRequest(request: CleanupRequest): {
  source: string;
  primary: string;
  commonDir: string;
  protectedPaths: string[];
} {
  if (!request || typeof request !== 'object') {
    throw new WorkspaceError('INVALID_INPUT', 'CleanupRequest must be an object.');
  }

  if (!request.sourceCheckout || typeof request.sourceCheckout !== 'string') {
    throw new WorkspaceError('INVALID_INPUT', 'sourceCheckout must be a non-empty string.');
  }

  if (!fs.existsSync(request.sourceCheckout)) {
    throw new WorkspaceError(
      'REPOSITORY_NOT_FOUND',
      `Directory is not a git repository: ${request.sourceCheckout}`,
    );
  }

  // Ensure valid Git repository
  findRepoRoot(request.sourceCheckout);
  const source = resolvePath(request.sourceCheckout);

  if (!request.rootIssueId || typeof request.rootIssueId !== 'string') {
    throw new WorkspaceError('INVALID_INPUT', 'rootIssueId must be provided as a non-empty string.');
  }

  if (!Array.isArray(request.candidates)) {
    throw new WorkspaceError('INVALID_INPUT', 'candidates must be an array.');
  }

  for (let i = 0; i < request.candidates.length; i++) {
    validateCleanupCandidate(request.candidates[i], i);
  }

  const primary = resolvePath(findPrimaryCheckout(source));
  const commonDir = getGitCommonDir(source);

  const rawProtected = Array.isArray(request.protectedPaths) ? request.protectedPaths : [];
  const protectedPaths = rawProtected.map((p) => resolvePath(p));

  return { source, primary, commonDir, protectedPaths };
}

/**
 * Check if target worktree path conflicts with source checkout, primary checkout, or protected paths.
 */
function checkPathProtection(
  target: string,
  source: string,
  primary: string,
  protectedPaths: string[],
): { isProtected: boolean; reasonCode?: string; reason?: string } {
  const resolvedTarget = resolvePath(target);

  // Check against source
  if (resolvedTarget === source || isParentDir(resolvedTarget, source)) {
    return {
      isProtected: true,
      reasonCode: 'PROTECTED_RESOURCE',
      reason: 'Candidate contains the retained checkout.',
    };
  }

  // Check against primary
  if (resolvedTarget === primary || isParentDir(resolvedTarget, primary)) {
    return {
      isProtected: true,
      reasonCode: 'PROTECTED_RESOURCE',
      reason: 'Primary checkout must be retained.',
    };
  }

  // Check against protected paths (receipts, etc.)
  for (const prot of protectedPaths) {
    if (resolvedTarget === prot || isParentDir(resolvedTarget, prot) || isParentDir(prot, resolvedTarget)) {
      return {
        isProtected: true,
        reasonCode: 'PROTECTED_RESOURCE',
        reason: 'Cleanup receipt must be outside the candidate.',
      };
    }
  }

  return { isProtected: false };
}

/**
 * Verify candidate ownership and completion flags.
 */
function verifyOwnershipAndCompletion(
  candidate: CleanupCandidate,
  rootIssueId: string,
): { valid: boolean; reasonCode?: string; reason?: string } {
  const candRecord = candidate as unknown as Record<string, unknown>;
  const created = ('created' in candidate && candidate.created === true) || candRecord.created === true;
  const ownership = (candidate.ownershipEvidence ?? candRecord.ownership_evidence) as
    | OwnershipEvidence
    | undefined;

  const historical =
    Boolean(
      ownership &&
        typeof ownership === 'object' &&
        ownership.issue &&
        ownership.source &&
        String(ownership.rootIssueId ?? ownership.root_issue_id) === String(rootIssueId),
    );

  if (!created && !historical) {
    return {
      valid: false,
      reasonCode: 'OWNERSHIP_UNVERIFIED',
      reason: 'Creation ownership or issue-tree evidence and completed consumers must be confirmed.',
    };
  }

  const consumersFinished =
    candidate.consumersFinished === true ||
    candRecord.consumers_finished === true;
  if (!consumersFinished) {
    return {
      valid: false,
      reasonCode: 'CONSUMERS_NOT_FINISHED',
      reason: 'Creation ownership or issue-tree evidence and completed consumers must be confirmed.',
    };
  }

  const isDetached = candidate.kind === 'detached';

  if (isDetached) {
    const verificationCompleted =
      (candidate as DetachedCleanupCandidate).verificationCompleted === true ||
      candRecord.verification_completed === true;
    if (!verificationCompleted) {
      return {
        valid: false,
        reasonCode: 'VERIFICATION_NOT_COMPLETED',
        reason: 'Detached worktree requires completed verification evidence.',
      };
    }
  }

  return { valid: true };
}

/**
 * Clean assigned candidates, retaining conflicts and reporting partial progress.
 */
export function cleanup(
  request: CleanupRequest,
  options?: CleanupOptions,
): CleanupResult {
  const { source, primary, commonDir, protectedPaths } = validateRequest(request);

  const ghRunner = options?.ghRunner ?? defaultGhRunner;
  const results: CandidateCleanupResult[] = [];

  for (const candidate of request.candidates) {
    const candidateResult: CandidateCleanupResult = { candidate };

    const rawWorktree = candidate.worktree;
    const hasWorktree = Boolean(rawWorktree && rawWorktree.trim());
    const target = hasWorktree ? resolvePath(rawWorktree!) : null;

    const branch =
      candidate.kind === 'task_branch' && candidate.branch ? candidate.branch : undefined;

    if (!target && !branch) {
      // Invalid candidate with neither worktree nor branch
      results.push({
        candidate,
        worktree: {
          status: 'retained',
          reasonCode: 'INVALID_CANDIDATE',
          reason: 'Branch-only cleanup requires a branch.',
        },
      });
      continue;
    }

    // 1. Verify ownership and consumer completion
    const ownershipCheck = verifyOwnershipAndCompletion(candidate, request.rootIssueId);
    if (!ownershipCheck.valid) {
      if (hasWorktree) {
        candidateResult.worktree = {
          status: 'retained',
          reasonCode: ownershipCheck.reasonCode,
          reason: ownershipCheck.reason,
        };
      }
      if (branch) {
        candidateResult.remoteBranch = {
          status: 'retained',
          reasonCode: ownershipCheck.reasonCode,
          reason: ownershipCheck.reason,
        };
        candidateResult.localBranch = {
          status: 'retained',
          reasonCode: ownershipCheck.reasonCode,
          reason: ownershipCheck.reason,
        };
      }
      results.push(candidateResult);
      continue;
    }

    // 2. Verify commit SHA
    const commit = candidate.commit ?? '';
    if (!isValidCommitSha(commit)) {
      const invalidReason = 'Candidate requires its recorded final full commit SHA.';
      if (hasWorktree) {
        candidateResult.worktree = {
          status: 'retained',
          reasonCode: 'INVALID_COMMIT',
          reason: invalidReason,
        };
      }
      if (branch) {
        candidateResult.remoteBranch = {
          status: 'retained',
          reasonCode: 'INVALID_COMMIT',
          reason: invalidReason,
        };
        candidateResult.localBranch = {
          status: 'retained',
          reasonCode: 'INVALID_COMMIT',
          reason: invalidReason,
        };
      }
      results.push(candidateResult);
      continue;
    }

    // 3. Check path safety if worktree is specified
    if (target) {
      const protection = checkPathProtection(target, source, primary, protectedPaths);
      if (protection.isProtected) {
        candidateResult.worktree = {
          status: 'retained',
          reasonCode: protection.reasonCode,
          reason: protection.reason,
        };
        if (branch) {
          candidateResult.remoteBranch = {
            status: 'retained',
            reasonCode: protection.reasonCode,
            reason: protection.reason,
          };
          candidateResult.localBranch = {
            status: 'retained',
            reasonCode: protection.reasonCode,
            reason: protection.reason,
          };
        }
        results.push(candidateResult);
        continue;
      }
    }

    // 4. Query registered worktrees
    const initialRegistrations = listWorktrees(source);
    let worktreeEntry: WorktreeEntry | undefined;

    if (target) {
      if (initialRegistrations.length > 0 && initialRegistrations[0].worktree === target) {
        candidateResult.worktree = {
          status: 'retained',
          reasonCode: 'PROTECTED_RESOURCE',
          reason: 'Primary checkout must be retained.',
        };
        if (branch) {
          candidateResult.remoteBranch = {
            status: 'retained',
            reasonCode: 'PROTECTED_RESOURCE',
            reason: 'Primary checkout must be retained.',
          };
          candidateResult.localBranch = {
            status: 'retained',
            reasonCode: 'PROTECTED_RESOURCE',
            reason: 'Primary checkout must be retained.',
          };
        }
        results.push(candidateResult);
        continue;
      }

      worktreeEntry = initialRegistrations.find((e) => e.worktree === target);

      if (worktreeEntry) {
        if (worktreeEntry.locked) {
          candidateResult.worktree = {
            status: 'retained',
            reasonCode: 'LOCKED_WORKTREE',
            reason: 'Worktree is locked by an active owner.',
          };
          if (branch) {
            candidateResult.remoteBranch = {
              status: 'retained',
              reasonCode: 'LOCKED_WORKTREE',
              reason: 'Worktree is locked by an active owner.',
            };
            candidateResult.localBranch = {
              status: 'retained',
              reasonCode: 'LOCKED_WORKTREE',
              reason: 'Worktree is locked by an active owner.',
            };
          }
          results.push(candidateResult);
          continue;
        }

        const expectedBranchRef = branch ? `refs/heads/${branch}` : undefined;
        if (
          worktreeEntry.HEAD !== commit ||
          (expectedBranchRef && worktreeEntry.branch !== expectedBranchRef)
        ) {
          candidateResult.worktree = {
            status: 'retained',
            reasonCode: 'HEAD_MISMATCH',
            reason: 'Registered branch or HEAD changed since delivery.',
          };
          if (branch) {
            candidateResult.remoteBranch = {
              status: 'retained',
              reasonCode: 'HEAD_MISMATCH',
              reason: 'Registered branch or HEAD changed since delivery.',
            };
            candidateResult.localBranch = {
              status: 'retained',
              reasonCode: 'HEAD_MISMATCH',
              reason: 'Registered branch or HEAD changed since delivery.',
            };
          }
          results.push(candidateResult);
          continue;
        }

        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          candidateResult.worktree = {
            status: 'retained',
            reasonCode: 'MISSING_WORKTREE',
            reason: 'Registered worktree is missing.',
          };
          if (branch) {
            candidateResult.remoteBranch = {
              status: 'retained',
              reasonCode: 'MISSING_WORKTREE',
              reason: 'Registered worktree is missing.',
            };
            candidateResult.localBranch = {
              status: 'retained',
              reasonCode: 'MISSING_WORKTREE',
              reason: 'Registered worktree is missing.',
            };
          }
          results.push(candidateResult);
          continue;
        }

        let targetCommonDir: string;
        try {
          targetCommonDir = getGitCommonDir(target);
        } catch {
          targetCommonDir = '';
        }
        if (targetCommonDir !== commonDir) {
          candidateResult.worktree = {
            status: 'retained',
            reasonCode: 'COMMON_DIR_MISMATCH',
            reason: 'Candidate belongs to a different repository.',
          };
          if (branch) {
            candidateResult.remoteBranch = {
              status: 'retained',
              reasonCode: 'COMMON_DIR_MISMATCH',
              reason: 'Candidate belongs to a different repository.',
            };
            candidateResult.localBranch = {
              status: 'retained',
              reasonCode: 'COMMON_DIR_MISMATCH',
              reason: 'Candidate belongs to a different repository.',
            };
          }
          results.push(candidateResult);
          continue;
        }

        if (!isClean(target, { includeIgnored: true })) {
          candidateResult.worktree = {
            status: 'retained',
            reasonCode: 'DIRTY_WORKTREE',
            reason: 'Candidate contains tracked, untracked, or ignored material.',
          };
          if (branch) {
            candidateResult.remoteBranch = {
              status: 'retained',
              reasonCode: 'DIRTY_WORKTREE',
              reason: 'Candidate contains tracked, untracked, or ignored material.',
            };
            candidateResult.localBranch = {
              status: 'retained',
              reasonCode: 'DIRTY_WORKTREE',
              reason: 'Candidate contains tracked, untracked, or ignored material.',
            };
          }
          results.push(candidateResult);
          continue;
        }
      } else if (fs.existsSync(target)) {
        // Target is unregistered on git, but directory exists
        candidateResult.worktree = {
          status: 'retained',
          reasonCode: 'UNREGISTERED_WORKTREE',
          reason: 'Candidate directory is unregistered.',
        };
        if (branch) {
          candidateResult.remoteBranch = {
            status: 'retained',
            reasonCode: 'UNREGISTERED_WORKTREE',
            reason: 'Candidate directory is unregistered.',
          };
          candidateResult.localBranch = {
            status: 'retained',
            reasonCode: 'UNREGISTERED_WORKTREE',
            reason: 'Candidate directory is unregistered.',
          };
        }
        results.push(candidateResult);
        continue;
      }
    }

    // 5. Branch mode validations and remote branch deletion
    let branchVerificationPassed = true;
    let localRefSha: string | null = null;

    if (branch) {
      try {
        if (!checkRefFormat(source, `refs/heads/${branch}`)) {
          throw new Error(`Invalid branch ref format: refs/heads/${branch}`);
        }

        const taskCand = candidate as TaskBranchCleanupCandidate;
        const candAny = candidate as unknown as Record<string, unknown>;
        const baseBranch = taskCand.baseBranch ?? (candAny.base_branch as string) ?? 'main';

        if (!checkRefFormat(source, `refs/heads/${baseBranch}`)) {
          throw new Error(`Invalid base branch ref format: refs/heads/${baseBranch}`);
        }

        if (branch === baseBranch) {
          throw new Error('Base branch must be retained.');
        }

        const ref = `refs/heads/${branch}`;
        const { code: refCode, stdout: refStdout } = runGit(
          source,
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          ref,
        );

        if (refCode === 0 && refStdout.trim()) {
          for (const line of refStdout.trim().split(/\r?\n/)) {
            const [refName, sha] = line.split(' ');
            if (refName === ref) {
              localRefSha = sha;
              break;
            }
          }
        }

        if (localRefSha && localRefSha !== commit) {
          throw new Error('Local branch has changed since delivery.');
        }

        if (
          initialRegistrations.some(
            (entry) => entry.branch === ref && entry.worktree !== (target ?? ''),
          )
        ) {
          throw new Error('Branch is checked out in another worktree.');
        }

        const deliveryTarget =
          taskCand.deliveryTarget ?? (candAny.delivery_target as string);
        if (!deliveryTarget) {
          throw new Error('Candidate requires deliveryTarget for branch verification.');
        }

        const prVal = taskCand.pr;
        if (prVal === undefined || prVal === null) {
          throw new Error('Candidate requires PR delivery evidence.');
        }

        const prId =
          typeof prVal === 'object' && 'number' in prVal
            ? String((prVal as PrDeliveryEvidence).number)
            : String(prVal);

        // Fetch PR evidence from GitHub
        const prJsonRaw = ghRunner(
          [
            'pr',
            'view',
            prId,
            '--repo',
            deliveryTarget,
            '--json',
            'state,headRefName,headRefOid,baseRefName,mergeCommit,headRepository,headRepositoryOwner',
          ],
          source,
        );

        const prData: PrViewPayload = JSON.parse(prJsonRaw);

        if (
          prData.state !== 'MERGED' ||
          prData.headRefName !== branch ||
          prData.headRefOid !== commit ||
          prData.baseRefName !== baseBranch
        ) {
          throw new Error('PR merge evidence does not match the delivered branch, base, and HEAD.');
        }

        const mergeCommitSha =
          typeof prData.mergeCommit === 'object' && prData.mergeCommit !== null
            ? prData.mergeCommit.oid
            : typeof prData.mergeCommit === 'string'
            ? prData.mergeCommit
            : '';

        if (!mergeCommitSha || !isValidCommitSha(mergeCommitSha)) {
          throw new Error('PR merge commit is missing.');
        }

        const baseRemote = taskCand.baseRemote ?? (candAny.base_remote as string) ?? 'origin';
        const baseUrl = getRemoteUrl(source, baseRemote);

        const baseRepoRaw = ghRunner(
          ['repo', 'view', baseUrl, '--json', 'nameWithOwner,defaultBranchRef'],
          source,
        );
        const baseRepo: RepoViewPayload = JSON.parse(baseRepoRaw);

        if (
          !baseRepo.nameWithOwner ||
          baseRepo.nameWithOwner.toLowerCase() !== deliveryTarget.toLowerCase()
        ) {
          throw new Error('Base remote differs from the delivery repository.');
        }

        // Fetch latest base branch ref and verify merge commit is an ancestor
        fetchRef(
          source,
          baseRemote,
          `+refs/heads/${baseBranch}:refs/remotes/${baseRemote}/${baseBranch}`,
        );

        if (!isAncestor(source, mergeCommitSha, `refs/remotes/${baseRemote}/${baseBranch}`)) {
          throw new Error('PR merge commit is not an ancestor of base remote branch.');
        }

        const pushRemote = taskCand.pushRemote ?? (candAny.push_remote as string) ?? 'origin';
        const remoteUrl = getRemoteUrl(source, pushRemote);

        const remoteRepoRaw = ghRunner(
          ['repo', 'view', remoteUrl, '--json', 'nameWithOwner,defaultBranchRef'],
          source,
        );
        const remoteRepo: RepoViewPayload = JSON.parse(remoteRepoRaw);

        const defaultBranches = new Set<string>();
        if (baseRepo.defaultBranchRef?.name) defaultBranches.add(baseRepo.defaultBranchRef.name);
        if (remoteRepo.defaultBranchRef?.name) defaultBranches.add(remoteRepo.defaultBranchRef.name);

        if (defaultBranches.has(branch)) {
          throw new Error('Default branch must be retained.');
        }

        const headOwner = prData.headRepositoryOwner?.login ?? '';
        const headRepoName =
          typeof prData.headRepository === 'object' && prData.headRepository !== null
            ? prData.headRepository.name ?? ''
            : typeof prData.headRepository === 'string'
            ? prData.headRepository
            : '';

        const expectedRepo =
          headOwner && headRepoName ? `${headOwner}/${headRepoName}` : headRepoName;

        if (
          !remoteRepo.nameWithOwner ||
          (expectedRepo && remoteRepo.nameWithOwner.toLowerCase() !== expectedRepo.toLowerCase())
        ) {
          throw new Error('Push remote differs from the PR head repository.');
        }

        // Check remote branch existence via ls-remote
        const { code: lsCode, stdout: lsStdout, stderr: lsStderr } = runGit(
          source,
          'ls-remote',
          '--refs',
          pushRemote,
          ref,
        );

        if (lsCode !== 0) {
          throw new Error(`Failed to check remote branch: ${lsStderr || lsStdout}`);
        }

        if (lsStdout.trim()) {
          const remoteHeadSha = lsStdout.trim().split(/\s+/)[0];
          if (remoteHeadSha !== commit) {
            throw new Error('Remote branch has changed since delivery.');
          }

          // Force-with-lease push deletion
          const { code: pushCode, stderr: pushErr, stdout: pushOut } = runGit(
            source,
            'push',
            `--force-with-lease=${ref}:${commit}`,
            pushRemote,
            `:${ref}`,
          );

          if (pushCode !== 0) {
            throw new Error(`Failed to remove remote branch: ${pushErr || pushOut}`);
          }

          candidateResult.remoteBranch = { status: 'removed' };
        } else {
          candidateResult.remoteBranch = { status: 'already_absent' };
        }
      } catch (err: unknown) {
        branchVerificationPassed = false;
        const reason = (err as Error).message || String(err);
        candidateResult.remoteBranch = {
          status: 'retained',
          reasonCode: 'PR_VERIFICATION_FAILED',
          reason,
        };
        candidateResult.localBranch = {
          status: 'retained',
          reasonCode: 'PR_VERIFICATION_FAILED',
          reason,
        };
        if (hasWorktree) {
          candidateResult.worktree = {
            status: 'retained',
            reasonCode: 'PR_VERIFICATION_FAILED',
            reason,
          };
        }
      }
    }

    if (!branchVerificationPassed) {
      results.push(candidateResult);
      continue;
    }

    // 6. Worktree removal
    if (target) {
      if (worktreeEntry) {
        // Re-confirm HEAD and clean status immediately before removal
        let headMatches: boolean;
        try {
          headMatches = getHeadCommit(target) === commit;
        } catch {
          headMatches = false;
        }

        if (!headMatches || !isClean(target, { includeIgnored: true })) {
          candidateResult.worktree = {
            status: 'retained',
            reasonCode: 'WORKTREE_CHANGED',
            reason: 'Worktree changed during cleanup.',
          };
          if (branch) {
            candidateResult.localBranch = {
              status: 'retained',
              reasonCode: 'WORKTREE_STILL_EXISTS',
              reason: 'Worktree removal was blocked.',
            };
          }
          results.push(candidateResult);
          continue;
        }

        try {
          removeWorktree(source, target);
          candidateResult.worktree = { status: 'removed' };
        } catch (err: unknown) {
          candidateResult.worktree = {
            status: 'retained',
            reasonCode: 'COMMAND_FAILED',
            reason: (err as Error).message,
          };
          if (branch) {
            candidateResult.localBranch = {
              status: 'retained',
              reasonCode: 'WORKTREE_STILL_EXISTS',
              reason: 'Worktree removal was blocked.',
            };
          }
          results.push(candidateResult);
          continue;
        }
      } else {
        // Not in registered worktrees
        if (!fs.existsSync(target)) {
          candidateResult.worktree = { status: 'already_absent' };
        } else {
          candidateResult.worktree = {
            status: 'retained',
            reasonCode: 'UNREGISTERED_WORKTREE',
            reason: 'Candidate directory is unregistered.',
          };
          if (branch) {
            candidateResult.localBranch = {
              status: 'retained',
              reasonCode: 'WORKTREE_STILL_EXISTS',
              reason: 'Candidate directory is unregistered.',
            };
          }
          results.push(candidateResult);
          continue;
        }
      }
    }

    // 7. Local branch deletion
    if (branch) {
      const ref = `refs/heads/${branch}`;
      const afterWorktrees = listWorktrees(source);

      if (afterWorktrees.some((e) => e.branch === ref)) {
        candidateResult.localBranch = {
          status: 'retained',
          reasonCode: 'BRANCH_CHECKED_OUT',
          reason: 'Branch is still checked out in a worktree.',
        };
      } else {
        // Check if local ref still exists
        const { code: refCheckCode } = runGit(
          source,
          'show-ref',
          '--verify',
          '--quiet',
          ref,
        );

        if (refCheckCode === 0) {
          try {
            updateRefDelete(source, ref, commit);
            removeBranchConfig(source, branch);
            candidateResult.localBranch = { status: 'removed' };
          } catch (err: unknown) {
            candidateResult.localBranch = {
              status: 'retained',
              reasonCode: 'COMMAND_FAILED',
              reason: (err as Error).message,
            };
          }
        } else {
          candidateResult.localBranch = { status: 'already_absent' };
        }
      }
    }

    results.push(candidateResult);
  }

  const unresolved = Array.isArray(request.unresolved) ? [...request.unresolved] : [];

  let hasRetained = false;
  for (const res of results) {
    if (res.worktree && res.worktree.status === 'retained') {
      hasRetained = true;
      break;
    }
    if (res.localBranch && res.localBranch.status === 'retained') {
      hasRetained = true;
      break;
    }
    if (res.remoteBranch && res.remoteBranch.status === 'retained') {
      hasRetained = true;
      break;
    }
  }

  const outcome = hasRetained || unresolved.length > 0 ? 'incomplete' : 'cleaned';

  return {
    outcome,
    candidates: results,
    unresolved,
  };
}
