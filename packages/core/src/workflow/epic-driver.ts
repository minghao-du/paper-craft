/** Repository-scoped EPIC planning and dependency-aware Worker dispatch. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDirectory } from './handoff.js';
import { workflowSource, type FleetConfig } from './fleet-config.js';
import { inspectConductor } from './runtime.js';
import { readIssue, type IssueInput, type IssueTurn, type RoundRunner } from './issue-driver.js';
/** EPIC professional judgment, separate from mechanical resource allocation. */
export interface EpicTask {
  number: number;
  title: string;
  body: string;
  brief: string;
  blockedBy: number[];
  ready: boolean;
  result?: string;
  checkout?: string;
}
/** Durable attributed plan and role exchanges; delivered is not EPIC closure. */
export interface EpicRun {
  repository: string;
  epic: number;
  goal: string;
  constraints: string[];
  tasks: EpicTask[];
  turns: IssueTurn[];
  status: 'running' | 'delivered' | 'blocked';
  error?: string;
}
function save(file: string, value: unknown) {
  const temp = file + '.' + randomUUID();
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}
function location(config: FleetConfig, repository: string, number: number) {
  return stateDirectory(
    config,
    '.runtime',
    'epics',
    createHash('sha256').update(`${config.file}:${repository}:${number}`).digest('hex'),
  );
}
/** Observe an EPIC without scheduling additional work. */
export function inspectEpicRun(
  config: FleetConfig,
  repository: string,
  number: number,
): EpicRun | undefined {
  const file = join(location(config, repository, number), 'epic.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}
/** Resolve the actual parent before choosing standalone or EPIC dispatch. */
export async function driveEpicIssue(
  config: FleetConfig,
  runner: RoundRunner,
  issue: IssueInput,
  maxWorkers = 2,
): Promise<EpicRun> {
  if (!issue.parent) throw new Error('Expected issue with verified EPIC parent');
  const epic = readIssue(config.project, issue.parent);
  if (epic.repository !== issue.repository) throw new Error('EPIC repository differs from Issue');
  return driveEpic(config, runner, epic, maxWorkers, issue);
}
/** Ask the EPIC Agent for professional readiness, then dispatch bounded independent batches. */
export async function driveEpic(
  config: FleetConfig,
  runner: RoundRunner,
  epic: IssueInput,
  maxWorkers = 2,
  intake?: IssueInput,
): Promise<EpicRun> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(epic.repository) ||
    !Number.isSafeInteger(epic.number) ||
    epic.number < 1 ||
    !Number.isSafeInteger(maxWorkers) ||
    maxWorkers < 1
  )
    throw new Error('Expected repository, positive EPIC number and Worker limit');
  await runner.preflight();
  const conductor = inspectConductor(config);
  if (!conductor?.conversation || conductor.status !== 'running')
    throw new Error('Expected acknowledged managed Conductor');
  const home = location(config, epic.repository, epic.number);
  mkdirSync(home, { recursive: true });
  const file = join(home, 'epic.json');
  const previous = inspectEpicRun(config, epic.repository, epic.number);
  if (previous?.status === 'delivered') return previous;
  if (previous)
    throw new Error('EPIC execution retained; reconcile original attempts before retry');
  const lock = join(stateDirectory(config, '.runtime'), `driver-${conductor.fleet}.lock`);
  mkdirSync(lock);
  const run: EpicRun = {
    repository: epic.repository,
    epic: epic.number,
    goal: epic.body,
    constraints: [],
    tasks: [],
    turns: [],
    status: 'running',
  };
  save(file, run);
  let epicConversation: string | undefined;
  async function turn(role: IssueTurn['role'], brief: string, checkout = config.project) {
    const id = randomUUID();
    const directory = stateDirectory(
      config,
      '.runtime',
      'epics',
      createHash('sha256').update(`${config.file}:${epic.repository}:${epic.number}`).digest('hex'),
      id,
    );
    mkdirSync(directory, { recursive: true });
    const t: IssueTurn = {
      id,
      fleet: conductor!.fleet,
      role,
      runner: runner.name,
      brief,
      status: 'starting',
      created: new Date().toISOString(),
      directory,
      checkout,
      conversation:
        role === 'epic'
          ? epicConversation
          : role === 'conductor'
            ? conductor!.conversation
            : undefined,
    };
    run.turns.push(t);
    writeFileSync(join(directory, 'brief.md'), brief);
    save(file, run);
    try {
      const receipt = await runner.start(t);
      if (!receipt.conversation || !receipt.address || !receipt.evidence)
        throw new Error('Expected actual Runner receipt');
      Object.assign(t, receipt, { status: 'running' });
      if (role === 'epic') epicConversation = t.conversation;
      save(file, run);
      t.result = await runner.collect(t);
      save(file, run);
      return t.result;
    } catch (error) {
      t.error = String(error);
      save(file, run);
      throw error;
    }
  }
  function plan(raw: string) {
    const p = JSON.parse(raw);
    if (
      typeof p.goal !== 'string' ||
      !p.goal.trim() ||
      !Array.isArray(p.constraints) ||
      !p.constraints.every((x: unknown) => typeof x === 'string') ||
      !Array.isArray(p.tasks)
    )
      throw new Error('Expected EPIC goal, constraints and task plan');
    const seen = new Set<number>();
    for (const t of p.tasks) {
      if (
        !Number.isSafeInteger(t.number) ||
        t.number < 1 ||
        t.number === epic.number ||
        seen.has(t.number) ||
        typeof t.brief !== 'string' ||
        !t.brief.trim() ||
        typeof t.title !== 'string' ||
        typeof t.body !== 'string' ||
        typeof t.ready !== 'boolean' ||
        !Array.isArray(t.blockedBy) ||
        !t.blockedBy.every((n: unknown) => Number.isSafeInteger(n))
      )
        throw new Error('Expected unique scoped tasks and dependency/readiness judgment');
      seen.add(t.number);
    }
    for (const t of p.tasks)
      if (t.blockedBy.some((n: number) => !seen.has(n) || n === t.number))
        throw new Error('Expected dependencies within EPIC plan');
    if (run.tasks.some((t) => !seen.has(t.number)))
      throw new Error('EPIC plan must retain existing tasks and delivery evidence');
    const delivered = new Map(run.tasks.filter((t) => t.result).map((t) => [t.number, t]));
    run.goal = p.goal;
    run.constraints = p.constraints;
    run.tasks = p.tasks.map((t: EpicTask) => ({
      ...t,
      result: delivered.get(t.number)?.result,
      checkout: delivered.get(t.number)?.checkout,
    }));
    save(file, run);
  }
  const schema =
    'Reply only JSON {"goal":"original objective","constraints":[],"tasks":[{"number":1,"title":"task","body":"scope","brief":"bounded stage","blockedBy":[],"ready":true}]}. Include every outstanding task and preserve delivered tasks. Judge semantic dependencies and readiness; Conductor alone allocates checkouts and launches Workers. Do not create Worker sessions yourself.';
  try {
    await runner.collect(conductor);
    plan(
      await turn(
        'epic',
        `Plan ${epic.repository} EPIC #${epic.number}: ${epic.title}\n${epic.body}\nIntake: ${JSON.stringify(intake)}\n${schema}`,
      ),
    );
    for (let cycle = 0; cycle < 20; cycle++) {
      const pending = run.tasks.filter((t) => !t.result);
      if (!pending.length) {
        run.status = 'delivered';
        save(file, run);
        return run;
      }
      const ready = pending
        .filter(
          (t) =>
            t.ready && t.blockedBy.every((n) => run.tasks.some((d) => d.number === n && d.result)),
        )
        .slice(0, maxWorkers);
      if (!ready.length)
        throw new Error('EPIC has unresolved semantic dependencies or readiness blockers');
      if (!config.worktrees) throw new Error('Automatic EPIC allocation requires local_worktrees');
      // Allocate serially: each checkout has one owner before concurrent execution begins.
      for (const task of ready) {
        const checkout = join(config.root, `issue-${task.number}`);
        if (existsSync(checkout))
          throw new Error('Checkout occupied or unknown; preserve existing owner');
        const key = createHash('sha256')
          .update(`${config.file}:${epic.repository}:${task.number}`)
          .digest('hex');
        execFileSync(
          'git',
          ['worktree', 'add', '-b', `codex/task-${key.slice(0, 16)}`, checkout, config.base],
          { cwd: config.project },
        );
        workflowSource(config, checkout);
        task.checkout = checkout;
        save(file, run);
      }
      const results = await Promise.allSettled(
        ready.map(async (t) => {
          t.result = await turn(
            'worker',
            `Read project AGENTS.md at ${join(config.project, 'AGENTS.md')} first and applicable lower directory guidance.\nRepository ${epic.repository}, EPIC #${epic.number}, Issue #${t.number}.\nScope: ${t.body}\n${t.brief}\nReturn stage result and evidence; stop after this stage.`,
            t.checkout,
          );
          save(file, run);
        }),
      );
      if (results.some((r) => r.status === 'rejected'))
        throw new Error(
          'Worker stage failed; retained attempts and checkout ownership require reconciliation',
        );
      await turn(
        'conductor',
        `EPIC ${epic.repository}#${epic.number} attributed Worker results: ${JSON.stringify(ready)}. Record results for professional EPIC evaluation. Reply with coordination feedback; do not dispatch duplicate work.`,
      );
      plan(
        await turn(
          'epic',
          `Evaluate delivered results and update professional readiness: ${JSON.stringify(run.tasks)}\nOriginal objective: ${epic.body}\n${schema}`,
        ),
      );
    }
    throw new Error('EPIC planning round limit reached');
  } catch (error) {
    run.status = 'blocked';
    run.error = error instanceof Error ? error.message : String(error);
    save(file, run);
    throw error;
  } finally {
    rmSync(lock, { recursive: true });
  }
}
