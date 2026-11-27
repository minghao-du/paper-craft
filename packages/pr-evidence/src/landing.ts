import { WorkspaceError } from '../../workspace/src/types.js';
import { readback, RevisionMismatch, verify, type CaptureOptions, type reviewedIdentity } from './evidence.js';
import { runGitHub } from './github-command.js';

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRevisionMismatch(error: unknown): boolean {
  return error instanceof RevisionMismatch || (error instanceof WorkspaceError && error.code === 'HEAD_MISMATCH');
}

/** Attempt at most one merge. Live PR state resolves interrupted and already-completed attempts. */
export function landReviewed(options: CaptureOptions, review: ReturnType<typeof reviewedIdentity>, issue?: string) {
  if (issue !== undefined && !/^[1-9][0-9]*$/.test(issue)) throw new Error('Expected a positive issue number');

  const identity = { repository: review.repository, prNumber: review.prNumber, evaluatedCommit: review.commit };
  let attempted = false;
  let failure: unknown;
  try {
    const verified = verify(options, review);
    attempted = true;
    runGitHub(options.workingDirectory, 'pr', 'merge', String(verified.prNumber), '--repo', verified.repository,
      '--squash', '--match-head-commit', verified.commit, ...(issue ? ['--body', `Refs #${issue}`] : []));
  } catch (error) {
    failure = error;
  }

  try {
    const observed = readback(options, review);
    if (observed.merged) return { ...observed, ...identity, outcome: 'landed' as const };
    return {
      ...observed, ...identity, outcome: isRevisionMismatch(failure) ? 'rework_needed' as const : 'blocked' as const,
      reason: failure ? message(failure) : `PR is ${observed.state} after merge request`,
    };
  } catch (error) {
    return {
      ...identity, outcome: isRevisionMismatch(error) || isRevisionMismatch(failure) ? 'rework_needed' as const : 'blocked' as const,
      mergeState: attempted ? 'unknown' : 'unverified',
      reason: [...new Set([failure, error].filter(Boolean).map(message))].join('\n'),
    };
  }
}
