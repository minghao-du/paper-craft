import path from 'node:path';
import { loadWorkspaceConfig, parseRepoFromUrl } from '../../workspace-config/src/index.js';
import { findRepoRoot, isValidCommitSha, listRemotes, requireClean, resolvePath, runGit } from './git.js';
import { WorkspaceError } from './types.js';

export interface AssignedEnvironment {
  workingDirectory: string;
  repository?: string;
  branch?: string | null;
  commit?: string | null;
  requireClean: boolean;
  baseRemote?: string;
}

export interface VerifiedEnvironment {
  workingDirectory: string;
  repository: string;
  baseRemote: string;
  branch: string | null;
  commit: string;
}

function verifyRepository(
  directory: string,
  assignment: AssignedEnvironment,
): Pick<VerifiedEnvironment, 'repository' | 'baseRemote'> {
  let expected = assignment.repository;
  let baseRemote = assignment.baseRemote;
  if (baseRemote === undefined) {
    let configuration: ReturnType<typeof loadWorkspaceConfig>;
    try {
      configuration = loadWorkspaceConfig({ repoDir: directory });
    } catch (err) {
      throw new WorkspaceError('CONFIG_INVALID', (err as Error).message, { directory });
    }
    const configuredRemote = configuration?.data.base_remote;
    const configuredRepository = configuration?.data.delivery_target;
    if (typeof configuredRemote === 'string' && configuredRemote.trim()) {
      baseRemote = configuredRemote.trim();
    }
    if (expected === undefined && typeof configuredRepository === 'string' && configuredRepository.trim()) {
      expected = configuredRepository.trim();
    }
  }
  if (baseRemote === undefined) {
    const remotes = listRemotes(directory);
    baseRemote = ['upstream', 'origin'].find((name) => remotes.includes(name)) ??
      (remotes.length === 1 ? remotes[0] : undefined);
    if (baseRemote === undefined) {
      throw new WorkspaceError(
        'REPOSITORY_NOT_FOUND',
        `Expected ${expected ?? 'a repository'} at ${directory}, but a base remote could not be selected. Observed ${remotes.join(', ') || 'no Git remotes'}. Supply its base remote.`,
        { directory, expected, observed: remotes },
      );
    }
  }

  const result = runGit(directory, 'remote', 'get-url', '--', baseRemote);
  const observed = result.code === 0 ? parseRepoFromUrl(result.stdout) : null;
  if (observed !== null && (expected === undefined || observed.toLowerCase() === expected.toLowerCase())) {
    return { repository: observed, baseRemote };
  }
  throw new WorkspaceError(
    'REPOSITORY_NOT_FOUND',
    `Expected repository ${expected ?? 'identity'} at ${directory}, observed ${observed ?? 'unavailable'} from base remote '${baseRemote}'. Reconcile the assignment with the configured Git remotes.`,
    { directory, baseRemote, expected, observed },
  );
}

/** Inspect the assigned Git checkout using local, read-only operations. */
export function verifyAssignedEnvironment(assignment: AssignedEnvironment): VerifiedEnvironment {
  const { workingDirectory, branch: expectedBranch, commit: expectedCommit } = assignment;
  if (!path.isAbsolute(workingDirectory)) {
    throw new WorkspaceError('INVALID_INPUT', `Supply an absolute assigned checkout path, received '${workingDirectory}'.`);
  }
  if (expectedCommit != null && !isValidCommitSha(expectedCommit)) {
    throw new WorkspaceError('INVALID_INPUT', `Expected a full commit SHA, received '${expectedCommit}'.`);
  }

  const directory = resolvePath(workingDirectory);
  let root: string;
  try {
    root = findRepoRoot(directory);
  } catch {
    throw new WorkspaceError(
      'REPOSITORY_NOT_FOUND',
      `Expected a Git checkout at ${directory}, but it could not be opened. Verify the assigned path and Git availability.`,
      { expected: directory, observed: null },
    );
  }
  if (root !== directory) {
    throw new WorkspaceError(
      'WORKTREE_CONFLICT',
      `Expected checkout root ${directory}, observed ${root}. Supply the assigned Git checkout root.`,
      { expected: directory, observed: root },
    );
  }

  const repository = verifyRepository(directory, assignment);
  const symbolic = runGit(directory, 'symbolic-ref', '--quiet', 'HEAD');
  if ((symbolic.code === 0 && !symbolic.stdout.startsWith('refs/heads/')) ||
      (symbolic.code !== 0 && symbolic.code !== 1)) {
    throw new WorkspaceError('VERIFICATION_FAILED', `Cannot determine the checked-out branch at ${directory}. Inspect its HEAD and retry.`);
  }
  const branch = symbolic.code === 0 ? symbolic.stdout.slice('refs/heads/'.length) : null;
  if (expectedBranch !== undefined && expectedBranch !== branch) {
    throw new WorkspaceError(
      'WORKTREE_CONFLICT',
      `Expected ${expectedBranch ?? 'detached HEAD'} at ${directory}, observed ${branch ?? 'detached HEAD'}. Use the checkout for the assigned branch or revision.`,
      { directory, expected: expectedBranch, observed: branch },
    );
  }

  const revision = runGit(directory, 'rev-parse', '--verify', 'HEAD^{commit}');
  if (revision.code !== 0 || !isValidCommitSha(revision.stdout)) {
    throw new WorkspaceError(
      'VERIFICATION_FAILED',
      `Expected ${expectedCommit ?? 'a commit'} at ${directory}, but HEAD could not be resolved. Inspect the assigned checkout and its Git state.`,
      { directory, expected: expectedCommit, observed: null },
    );
  }
  const commit = revision.stdout;
  if (expectedCommit != null && expectedCommit.toLowerCase() !== commit) {
    throw new WorkspaceError(
      'HEAD_MISMATCH',
      `Expected HEAD ${expectedCommit} at ${directory}, observed ${commit}. Reconcile the assigned revision before retrying.`,
      { directory, expected: expectedCommit, observed: commit },
    );
  }
  if (assignment.requireClean) requireClean(directory);
  return { workingDirectory: directory, ...repository, branch, commit };
}
