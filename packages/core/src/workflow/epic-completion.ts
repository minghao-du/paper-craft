/** Goal acceptance and the sole human workflow approval: closing an EPIC. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from './handoff.js';
import type { FleetConfig } from './fleet-config.js';
import type { EpicRun, EpicTask } from './epic-driver.js';
import type { RoundRunner, IssueTurn } from './issue-driver.js';
/** Only the calling human-facing host may supply this decision, never a model result. */
export interface EpicCloseDecision {
  epic: number;
  confirmed: boolean;
  source: 'human';
  evidence: string;
}
/** Delivery performs head-bound professional gates and verified postmerge completion. */
export interface EpicCompletionProvider {
  deliver(task: EpicTask): Promise<string>;
  close(epic: number): Promise<void>;
}
/** Retained professional judgment and target-specific human decision. */
export interface EpicCompletion {
  status: 'blocked' | 'awaiting_confirmation' | 'closed';
  deliveries: Record<string, string>;
  turns: IssueTurn[];
  acceptance?: { satisfied: boolean; criteria: string[]; blockers: string[] };
  request?: string;
  decision?: EpicCloseDecision;
  archive?: string;
}
/** Finish each child, evaluate the original objective, and wait for explicit human closure. */
export async function completeEpic(
  config: FleetConfig,
  runner: RoundRunner,
  provider: EpicCompletionProvider,
  epic: EpicRun,
  decision?: EpicCloseDecision,
): Promise<EpicCompletion> {
  const key = createHash('sha256')
    .update(`${config.file}:${epic.repository}:${epic.epic}`)
    .digest('hex');
  const home = stateDirectory(config, '.runtime', 'epic-completion', key),
    file = join(home, 'completion.json');
  const lock = join(home, 'driver.lock');
  mkdirSync(lock);
  try {
    const run: EpicCompletion = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { status: 'blocked', deliveries: {}, turns: [] };
    const save = () => {
      const temp = file + randomUUID();
      writeFileSync(temp, JSON.stringify(run, null, 2));
      renameSync(temp, file);
    };
    if (run.status === 'closed') return run;
    if (
      epic.status !== 'delivered' ||
      !epic.tasks.length ||
      epic.tasks.some((t) => !t.result || !t.checkout)
    )
      throw new Error('Expected all attributed EPIC deliveries before goal acceptance');
    for (const t of epic.tasks)
      if (!run.deliveries[t.number]) {
        run.deliveries[t.number] = await provider.deliver(t);
        save();
      }
    const turn = async (role: 'epic' | 'conductor', brief: string) => {
      const id = randomUUID(),
        directory = stateDirectory(config, '.runtime', 'epic-completion', key, id);
      const attempt: IssueTurn = {
        id,
        directory,
        brief,
        role,
        fleet: createHash('sha256').update(config.file).digest('hex'),
        runner: runner.name,
        status: 'starting',
        checkout: config.project,
        created: new Date().toISOString(),
      };
      run.turns.push(attempt);
      writeFileSync(join(directory, 'brief.md'), brief);
      save();
      Object.assign(attempt, await runner.start(attempt), { status: 'running' });
      if (!attempt.conversation || !attempt.evidence || !attempt.address)
        throw new Error('Expected actual Runner receipt');
      save();
      attempt.result = await runner.collect(attempt);
      save();
      return attempt.result;
    };
    if (!run.acceptance?.satisfied) {
      const answer = JSON.parse(
        await turn(
          'epic',
          `Judge original EPIC ${epic.repository}#${epic.epic} goal and acceptance conditions: ${epic.originalGoal ?? epic.goal}\nConstraints ${JSON.stringify(epic.constraints)}\nResults ${JSON.stringify(epic.tasks)}\nVerified completions ${JSON.stringify(run.deliveries)}\nDo not infer goal success from closed Issues. Reply JSON {"satisfied":true,"criteria":["criterion and evidence"],"blockers":[]}.`,
        ),
      );
      if (
        typeof answer.satisfied !== 'boolean' ||
        !Array.isArray(answer.criteria) ||
        !answer.criteria.length ||
        !answer.criteria.every((x: unknown) => typeof x === 'string' && x.trim()) ||
        !Array.isArray(answer.blockers) ||
        !answer.blockers.every((x: unknown) => typeof x === 'string')
      )
        throw new Error('Expected professional criteria, evidence and blockers');
      run.acceptance = answer;
      save();
    }
    if (!run.acceptance!.satisfied || run.acceptance!.blockers.length) {
      run.status = 'blocked';
      save();
      return run;
    }
    if (!run.request) {
      run.request = await turn(
        'conductor',
        `Present evidence and request one explicit human confirmation to close EPIC ${epic.repository}#${epic.epic}. Goal ${epic.originalGoal ?? epic.goal}; acceptance ${JSON.stringify(run.acceptance)}; deliveries ${JSON.stringify(run.deliveries)}. Do not close without human confirmation.`,
      );
      save();
    }
    run.status = 'awaiting_confirmation';
    if (decision) {
      if (decision.epic !== epic.epic || decision.source !== 'human' || !decision.evidence.trim())
        throw new Error('Expected explicit human decision for this EPIC');
      run.decision = decision;
      save();
    }
    if (run.decision?.confirmed) {
      await provider.close(epic.epic);
      run.archive = join(home, 'accepted.json');
      writeFileSync(
        run.archive,
        JSON.stringify(
          { epic, acceptance: run.acceptance, deliveries: run.deliveries, decision: run.decision },
          null,
          2,
        ),
      );
      run.status = 'closed';
    }
    save();
    return run;
  } finally {
    rmSync(lock, { recursive: true });
  }
}
