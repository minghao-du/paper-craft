/** Read-only GitHub delivery observations using the existing gh login. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DashboardFleet, DashboardTask } from '@paper-craft/core/workflow/dashboard';
const execute = promisify(execFile);
async function command(program: string, args: string[]) {
  const { stdout } = await execute(program, args, {
    timeout: 5000,
    maxBuffer: 256 * 1024,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
  return stdout.trim();
}
/** Attributed delivery result; an open PR never establishes an approval request. */
export interface GitHubEvidence {
  fleetId: string;
  taskId: string;
  source: string;
  observedAt: string;
  lastSuccessAt?: string;
  stale: boolean;
  error?: string;
  approvalRequest: 'unknown';
  value?: { repository: string; issue?: unknown; pr?: unknown };
}
/** Independently cached, bounded GitHub collection; HTTP reads never run gh. */
export function githubCollector(interval = 180000) {
  const cache = new Map<string, GitHubEvidence>();
  const due = new Map<string, number>();
  const failures = new Map<string, number>();
  let running: Promise<void> | undefined;
  const associations = new Map<string, string>();
  async function inspect(fleet: DashboardFleet, task: DashboardTask) {
    const association = JSON.stringify([task.issue, task.pr, task.path]);
    if (associations.get(task.id) !== association) {
      cache.delete(task.id);
      due.delete(task.id);
      failures.delete(task.id);
      associations.set(task.id, association);
    }
    if (!task.issue && !task.pr) return;
    if (Date.now() < (due.get(task.id) ?? 0)) return;
    const previous = cache.get(task.id);
    const result: GitHubEvidence = {
      fleetId: fleet.id,
      taskId: task.id,
      source: task.source,
      observedAt: new Date().toISOString(),
      stale: false,
      approvalRequest: 'unknown',
    };
    try {
      if (task.error || fleet.error) throw new Error('Workflow association unavailable');
      const origin = await command('git', ['-C', task.path, 'remote', 'get-url', 'origin']);
      const match =
        /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin);
      if (!match) throw new Error('Expected an explicit github.com repository origin');
      const repository = match[1];
      const value: NonNullable<GitHubEvidence['value']> = { repository };
      if (task.issue) {
        if (!Number.isSafeInteger(task.issue) || task.issue < 1)
          throw new Error('Invalid recorded Issue number');
        value.issue = JSON.parse(
          await command('gh', [
            'issue',
            'view',
            String(task.issue),
            '--repo',
            repository,
            '--json',
            'number,title,state,url',
          ]),
        );
      }
      if (task.pr) {
        let number = task.pr;
        if (!/^\d+$/.test(number)) {
          const pr = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(number);
          if (!pr || pr[1].toLowerCase() !== repository.toLowerCase())
            throw new Error('PR association does not match the recorded repository');
          number = pr[2];
        }
        if (!Number.isSafeInteger(Number(number)) || Number(number) < 1)
          throw new Error('Invalid recorded PR number');
        value.pr = JSON.parse(
          await command('gh', [
            'pr',
            'view',
            number,
            '--repo',
            repository,
            '--json',
            'number,title,state,url,isDraft,reviewDecision,statusCheckRollup,reviews',
          ]),
        );
      }
      result.value = value;
      result.lastSuccessAt = result.observedAt;
      failures.set(task.id, 0);
    } catch {
      // Never echo command errors: stderr can contain local credentials or private material.
      result.error =
        'GitHub evidence unavailable: verify repository/Issue/PR association, run gh auth login in a terminal, or retry after network/rate-limit recovery.';
      result.value = previous?.value;
      result.lastSuccessAt = previous?.lastSuccessAt;
      result.stale = !!previous?.value;
      failures.set(task.id, Math.min((failures.get(task.id) ?? 0) + 1, 5));
    }
    cache.set(task.id, result);
    due.set(task.id, Date.now() + Math.max(100, interval) * 2 ** (failures.get(task.id) ?? 0));
  }
  return {
    values: () => [...cache.values()],
    refresh(fleets: DashboardFleet[]) {
      if (running) return running;
      running = (async () => {
        for (const fleet of fleets) for (const task of fleet.tasks) await inspect(fleet, task);
      })().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
