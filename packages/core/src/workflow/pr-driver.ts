/** Current-head PR quality, repair and automatic landing workflow. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDirectory } from './handoff.js';
import { workflowSource, type FleetConfig } from './fleet-config.js';
import type { RoundRunner, IssueTurn } from './issue-driver.js';
/** Repository-scoped delivery; EPIC professional evidence is bound to its head. */
export interface PrDelivery {
  repository: string;
  issue: number;
  checkout: string;
  epic?: number;
  confirmation?: { epic: number; head: string; evidence: string };
  /** Re-evaluate professional approval whenever the live head changes. */
  confirmHead?: (head: string) => Promise<{ epic: number; head: string; evidence: string }>;
}
/** Live provider evidence and compare-and-merge operation. */
export interface PullRequestProvider {
  ensure(delivery: PrDelivery): Promise<number>;
  read(pr: number): Promise<{ head: string; state: string; conflict: boolean }>;
  checks(pr: number): Promise<'passed' | 'failed' | 'pending'>;
  merge(pr: number, head: string): Promise<void>;
}
/** Durable gate results and execution receipts survive failed collection. */
export interface PrRun {
  pr: number;
  status: 'running' | 'merged' | 'blocked';
  turns: IssueTurn[];
  checkedHead?: string;
  error?: string;
}
function save(file: string, value: PrRun) {
  const temp = file + '.' + randomUUID();
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}
/** Drive repair and Landing automatically; only live evidence authorizes merge. */
export async function drivePullRequest(
  config: FleetConfig,
  runner: RoundRunner,
  github: PullRequestProvider,
  delivery: PrDelivery,
): Promise<PrRun> {
  workflowSource(config, delivery.checkout);
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(delivery.repository) ||
    !Number.isSafeInteger(delivery.issue) ||
    delivery.issue < 1
  )
    throw new Error('Expected repository and positive Issue identity');
  await runner.preflight();
  const key = createHash('sha256')
    .update(`${config.file}:${delivery.repository}:${delivery.issue}`)
    .digest('hex');
  const home = stateDirectory(config, '.runtime', 'pull-requests', key);
  mkdirSync(home, { recursive: true });
  const file = join(home, 'pr.json'),
    lock = join(home, 'driver.lock');
  mkdirSync(lock);
  let run: PrRun | undefined;
  try {
    run = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { pr: await github.ensure(delivery), status: 'running', turns: [] };
    const state = run!;
    save(file, state);
    let repair = false;
    for (let round = 0; round < 12; round++) {
      const live = await github.read(state.pr);
      if (live.state === 'MERGED') {
        state.status = 'merged';
        save(file, state);
        return state;
      }
      if (live.state !== 'OPEN') throw new Error('Expected open PR');
      const checks = await github.checks(state.pr);
      if (checks === 'pending') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      const failed = repair || checks === 'failed' || live.conflict;
      repair = false;
      if (
        !failed &&
        delivery.epic &&
        delivery.confirmHead &&
        delivery.confirmation?.head !== live.head
      )
        delivery.confirmation = await delivery.confirmHead(live.head);
      if (
        !failed &&
        delivery.epic &&
        !(
          delivery.confirmation?.epic === delivery.epic &&
          delivery.confirmation.head === live.head &&
          delivery.confirmation.evidence.trim()
        )
      )
        throw new Error('Missing current-head EPIC professional confirmation');
      const role = failed ? 'worker' : 'landing';
      const previous = state.turns.at(-1);
      if (previous && !previous.result)
        throw new Error('Uncollected original execution; reconcile before another attempt');
      const id = randomUUID(),
        directory = stateDirectory(config, '.runtime', 'pull-requests', key, id);
      mkdirSync(directory, { recursive: true });
      const turn: IssueTurn = {
        id,
        fleet: createHash('sha256').update(config.file).digest('hex'),
        role,
        runner: runner.name,
        status: 'starting',
        created: new Date().toISOString(),
        directory,
        checkout: delivery.checkout,
        brief: `Read project AGENTS.md and applicable checkout guidance. ${delivery.repository} Issue #${delivery.issue}, PR #${state.pr}, head ${live.head}. ${failed ? 'Repair failed checks or conflicts; push fixes and return evidence.' : 'Run pc-pr-check and pc-pr-review quality gates at this head; return JSON {"passed":true,"head":"' + live.head + '","evidence":"quality outcomes"} only if all applicable gates pass. Do not merge; the driver performs compare-and-merge.'}`,
      };
      writeFileSync(join(directory, 'brief.md'), turn.brief);
      state.turns.push(turn);
      save(file, state);
      const receipt = await runner.start(turn);
      if (!receipt.conversation || !receipt.address || !receipt.evidence)
        throw new Error('Missing execution receipt');
      Object.assign(turn, receipt, { status: 'running' });
      save(file, state);
      turn.result = await runner.collect(turn);
      save(file, state);
      if (failed) continue;
      const gate = JSON.parse(turn.result);
      if (
        gate.passed !== true ||
        gate.head !== live.head ||
        typeof gate.evidence !== 'string' ||
        !gate.evidence.trim()
      ) {
        repair = true;
        continue;
      }
      const fresh = await github.read(state.pr);
      if (fresh.head !== live.head || fresh.conflict) continue;
      if ((await github.checks(state.pr)) !== 'passed') continue;
      state.checkedHead = live.head;
      save(file, state);
      try {
        await github.merge(state.pr, live.head);
      } catch (error) {
        const changed = await github.read(state.pr);
        if (changed.state === 'MERGED') continue;
        if (changed.head !== live.head) continue;
        throw error;
      }
      const merged = await github.read(state.pr);
      if (merged.state !== 'MERGED') throw new Error('Merge not verified');
      state.status = 'merged';
      save(file, state);
      return state;
    }
    throw new Error('Repair loop limit reached; preserve checkout and evidence');
  } catch (error) {
    if (run) {
      run.status = 'blocked';
      run.error = error instanceof Error ? error.message : String(error);
      save(file, run);
    }
    throw error;
  } finally {
    rmSync(lock, { recursive: true });
  }
}
/** GitHub CLI adapter; checks and atomic expected-head merge remain provider operations. */
export class GitHubPullRequests implements PullRequestProvider {
  constructor(
    private readonly checkout: string,
    private readonly repository: string,
  ) {}
  private gh(args: string[]): string {
    return execFileSync('gh', args, { cwd: this.checkout, encoding: 'utf8' }).trim();
  }
  /** Reuse a branch PR, or create one from delivered commits. */
  async ensure(): Promise<number> {
    const prs = JSON.parse(
      this.gh([
        'pr',
        'list',
        '--repo',
        this.repository,
        '--head',
        execFileSync('git', ['branch', '--show-current'], {
          cwd: this.checkout,
          encoding: 'utf8',
        }).trim(),
        '--json',
        'number',
      ]),
    );
    if (prs.length) return prs[0].number;
    execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: this.checkout });
    this.gh(['pr', 'create', '--repo', this.repository, '--fill']);
    return JSON.parse(this.gh(['pr', 'view', '--json', 'number'])).number;
  }
  /** Read the live head and merge status again at each decision. */
  async read(pr: number) {
    const p = JSON.parse(
      this.gh([
        'pr',
        'view',
        String(pr),
        '--repo',
        this.repository,
        '--json',
        'headRefOid,state,mergeable',
      ]),
    );
    return { head: p.headRefOid, state: p.state, conflict: p.mergeable !== 'MERGEABLE' };
  }
  /** Verify merge state before post-merge side effects. */
  async merged(pr: number): Promise<boolean> {
    return (await this.read(pr)).state === 'MERGED';
  }
  /** GitHub close is idempotent; verify actual state after the request. */
  async close(issue: number): Promise<void> {
    const args = ['issue', 'view', String(issue), '--repo', this.repository, '--json', 'state'];
    if (JSON.parse(this.gh(args)).state !== 'CLOSED')
      this.gh(['issue', 'close', String(issue), '--repo', this.repository]);
    if (JSON.parse(this.gh(args)).state !== 'CLOSED') throw new Error('Issue closure not verified');
  }
  /** Required check results only; no required checks is permitted. */
  async checks(pr: number): Promise<'passed' | 'failed' | 'pending'> {
    let raw: string;
    try {
      raw = this.gh([
        'pr',
        'checks',
        String(pr),
        '--repo',
        this.repository,
        '--required',
        '--json',
        'bucket',
      ]);
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? '');
      if (/no (required )?checks reported/i.test(stderr)) return 'passed';
      const stdout = (error as { stdout?: string }).stdout;
      if (!stdout) throw error;
      raw = stdout;
    }
    const checks = JSON.parse(raw) as { bucket: string }[];
    return checks.some((c) => ['fail', 'cancel'].includes(c.bucket))
      ? 'failed'
      : checks.some((c) => c.bucket !== 'pass' && c.bucket !== 'skipping')
        ? 'pending'
        : 'passed';
  }
  /** GitHub rejects a moved head instead of merging unchecked commits. */
  async merge(pr: number, head: string) {
    if (
      execFileSync('git', ['status', '--porcelain'], {
        cwd: this.checkout,
        encoding: 'utf8',
      }).trim()
    )
      throw new Error('Worker must account for dirty checkout before merge');
    if (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.checkout,
        encoding: 'utf8',
      }).trim() !== head
    )
      throw new Error('Local HEAD differs from evaluated PR head');
    const base = JSON.parse(
      this.gh(['pr', 'view', String(pr), '--repo', this.repository, '--json', 'baseRefName']),
    ).baseRefName;
    execFileSync('git', ['fetch', 'origin', base], { cwd: this.checkout });
    execFileSync('git', ['merge-base', '--is-ancestor', `origin/${base}`, head], {
      cwd: this.checkout,
    });
    this.gh([
      'pr',
      'merge',
      String(pr),
      '--repo',
      this.repository,
      '--squash',
      '--match-head-commit',
      head,
    ]);
  }
}
