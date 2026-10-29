/** Connect professional head gates and final human EPIC closure to public workflow. */
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { completeEpic, type EpicCloseDecision } from '@paper-craft/core/workflow/epic-completion';
import { landDelivery } from '@paper-craft/core/workflow/postmerge';
import { GitHubPullRequests } from '@paper-craft/core/workflow/pr-driver';
import { stateDirectory } from '@paper-craft/core/workflow/handoff';
import type { FleetConfig } from '@paper-craft/core/workflow/fleet-config';
import type { EpicRun } from '@paper-craft/core/workflow/epic-driver';
import type { CompletionRunner } from '@paper-craft/core/workflow/postmerge';
import type { IssueTurn } from '@paper-craft/core/workflow/issue-driver';
/** No intermediate human approval; head-specific professional judgment comes from EPIC role. */
export async function finishEpic(
  config: FleetConfig,
  runner: CompletionRunner,
  epic: EpicRun,
  decision?: EpicCloseDecision,
) {
  return completeEpic(
    config,
    runner,
    {
      async deliver(task) {
        const checkout = task.checkout!,
          github = new GitHubPullRequests(checkout, epic.repository);
        const delivery = {
          repository: epic.repository,
          issue: task.number,
          checkout,
          epic: epic.epic,
        };
        const pr = await github.ensure(),
          head = (await github.read(pr)).head;
        const confirmHead = async (head: string) => {
          const id = randomUUID(),
            directory = stateDirectory(config, '.runtime', 'epic-gates', id);
          const brief = `Read AGENTS.md. Professionally review delivery ${epic.repository}#${task.number} PR #${pr} head ${head} against EPIC #${epic.epic} original objective ${epic.goal} and task ${task.body}. Result ${task.result}. Reply only JSON {"approved":true,"evidence":"review findings"}. Approval is professional judgment, not human EPIC closure.`;
          const turn: IssueTurn = {
            id,
            directory,
            brief,
            role: 'epic',
            fleet: createHash('sha256').update(config.file).digest('hex'),
            runner: runner.name,
            status: 'starting',
            checkout: config.project,
            created: new Date().toISOString(),
          };
          const save = () =>
            writeFileSync(join(directory, 'attempt.json'), JSON.stringify(turn, null, 2));
          writeFileSync(join(directory, 'brief.md'), brief);
          save();
          Object.assign(turn, await runner.start(turn), { status: 'running' });
          save();
          turn.result = await runner.collect(turn);
          save();
          const approval = JSON.parse(turn.result);
          if (
            approval.approved !== true ||
            typeof approval.evidence !== 'string' ||
            !approval.evidence.trim()
          )
            throw new Error('EPIC professional approval missing; retain delivery for repair');
          return { epic: epic.epic, head, evidence: approval.evidence };
        };
        const result = await landDelivery(
          config,
          runner,
          github,
          { ...delivery, confirmation: await confirmHead(head), confirmHead },
          epic.turns.filter((t) => t.checkout === checkout),
        );
        return JSON.stringify(result);
      },
      async close(number) {
        execFileSync('gh', ['issue', 'close', String(number), '--repo', epic.repository], {
          cwd: config.project,
        });
        const state = execFileSync(
          'gh',
          [
            'issue',
            'view',
            String(number),
            '--repo',
            epic.repository,
            '--json',
            'state',
            '--jq',
            '.state',
          ],
          { cwd: config.project, encoding: 'utf8' },
        ).trim();
        if (state !== 'CLOSED') throw new Error('Expected actual EPIC closed state');
      },
    },
    epic,
    decision,
  );
}
