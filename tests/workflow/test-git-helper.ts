/**
 * @fileoverview Test helper for initializing real temporary Git repositories.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Initializes a temporary directory as a real Git repository with an initial commit on main.
 *
 * @param dir Target directory to initialize as a Git repository.
 */
export async function initTestGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'test-user'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'Initial commit'], { cwd: dir });
}
