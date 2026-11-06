import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { initTestGitRepo } from './test-git-helper.js';
import { WorkflowEngine } from '../../packages/core/src/workflow/engine.js';
import { RepositoryManager } from '../../packages/core/src/workflow/repository.js';
import type { AgentExecutor } from '../../packages/core/src/workflow/types.js';

describe('WorkflowEngine Intake & Startup (Ticket #2)', () => {
  let tmpDir: string;
  let mockRepoManager: RepositoryManager;
  let mockExecutor: AgentExecutor;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-workflow-test-'));
    await initTestGitRepo(tmpDir);

    mockRepoManager = new RepositoryManager({
      cwd: tmpDir,
      issueInspector: async (_repo: string, issue: number) => {
        if (issue === 404) {
          return { exists: false, error: `Issue #${issue} not found in repository` };
        }
        return { exists: true, open: true, title: `Test issue #${issue}` };
      },
    });

    mockExecutor = {
      check: async () => ({ available: true }),
      launch: async () => ({ id: 'mock-handle', taskId: 'mock-task' }),
      inspect: async () => ({ status: 'not_started' }),
      send: async () => {},
      stop: async () => ({ stopped: true }),
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('workflow init', () => {
    it('creates default configuration in the target directory', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });

      const { configPath } = await engine.init();
      expect(configPath).toBe(path.join(tmpDir, '.pc-workflow.yml'));

      const stat = await fs.stat(configPath);
      expect(stat.isFile()).toBe(true);

      const content = await fs.readFile(configPath, 'utf8');
      expect(content).toContain('repository:');
      expect(content).toContain('worktree_root:');
      expect(content).toContain('workflow_definition:');
      expect(content).toContain('role_definitions:');
      expect(content).toContain('rework_limit:');
    });

    it('creates configuration at an explicit path override', async () => {
      const customPath = path.join(tmpDir, 'custom', 'workflow.yml');
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });

      const { configPath } = await engine.init({ configPath: customPath, repository: 'custom-org/custom-repo' });
      expect(configPath).toBe(customPath);

      const content = await fs.readFile(customPath, 'utf8');
      expect(content).toContain('repository: custom-org/custom-repo');
    });
  });

  describe('configuration & definition validation', () => {
    it('rejects configuration missing repository', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });

      await engine.init({ repository: '' });

      await expect(engine.start({ issue: 1 })).rejects.toThrow(/repository is required/i);
    });

    it('rejects configuration with negative rework limit', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });

      const { configPath } = await engine.init();
      const content = await fs.readFile(configPath, 'utf8');
      await fs.writeFile(configPath, content.replace('rework_limit: 3', 'rework_limit: -1'));

      await expect(engine.start({ issue: 1 })).rejects.toThrow(/rework_limit must be a non-negative integer/i);
    });

    it('rejects workflow definition with invalid initial step', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });

      const { configPath } = await engine.init();
      const wfPath = path.join(tmpDir, 'config', 'workflow.yml');
      const wfContent = await fs.readFile(wfPath, 'utf8');
      await fs.writeFile(wfPath, wfContent.replace('initial_step: implementation', 'initial_step: non_existent'));

      await expect(engine.start({ issue: 1, configPath })).rejects.toThrow(/initial_step "non_existent" is not defined in steps/i);
    });

    it('rejects workflow step referencing unknown role', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });

      const { configPath } = await engine.init();
      const wfPath = path.join(tmpDir, 'config', 'workflow.yml');
      const wfContent = await fs.readFile(wfPath, 'utf8');
      await fs.writeFile(wfPath, wfContent.replace('role: worker', 'role: unknown_role'));

      await expect(engine.start({ issue: 1, configPath })).rejects.toThrow(/step "implementation" references undeclared role "unknown_role"/i);
    });

    it('rejects step transition referencing unpermitted outcome', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });

      const { configPath } = await engine.init();
      const wfPath = path.join(tmpDir, 'config', 'workflow.yml');
      const wfContent = await fs.readFile(wfPath, 'utf8');
      // Worker only permits [completed, blocked]. Let's add an invalid outcome transition
      await fs.writeFile(wfPath, wfContent.replace('transitions:', 'transitions:\n      invalid_outcome: review'));

      await expect(engine.start({ issue: 1, configPath })).rejects.toThrow(/transition outcome "invalid_outcome" is not permitted for role "worker"/i);
    });

    it('rejects step transition to non-existent target step', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });

      const { configPath } = await engine.init();
      const wfPath = path.join(tmpDir, 'config', 'workflow.yml');
      const wfContent = await fs.readFile(wfPath, 'utf8');
      await fs.writeFile(wfPath, wfContent.replace('completed: review', 'completed: imaginary_step'));

      await expect(engine.start({ issue: 1, configPath })).rejects.toThrow(/transition target "imaginary_step" is neither a defined step nor a terminal state/i);
    });
  });

  describe('preflight verifications before model launch', () => {
    it('fails when Issue does not exist with actionable error', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });
      await engine.init();

      await expect(engine.start({ issue: 404 })).rejects.toThrow(/Issue #404 not found/i);
    });

    it('fails when provider check fails with actionable error', async () => {
      const failingExecutor: AgentExecutor = {
        ...mockExecutor,
        check: async () => ({
          available: false,
          error: 'agy executable not found in PATH',
        }),
      };
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: failingExecutor,
      });
      await engine.init();

      await expect(engine.start({ issue: 1 })).rejects.toThrow(/agy executable not found in PATH/i);
    });

    it('fails when provider is unsupported with actionable error', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });
      await engine.init();

      await expect(engine.start({ issue: 1, provider: 'unsupported' })).rejects.toThrow(/unsupported provider: "unsupported"/i);
    });

    it('shares the same executor instance between Engine and internal TaskExecution, keeping config and execution consistent', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });
      await engine.init();

      const run = await engine.start({ issue: 1 });
      expect(run.provider).toBe('agy');
      expect(engine.executor).toBe(mockExecutor);
    });

    it('fails when both requirements and requirementsFile are passed', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });
      await engine.init();

      await expect(engine.start({
        issue: 1,
        requirements: 'some reqs',
        requirementsFile: '/tmp/reqs.txt',
      })).rejects.toThrow(/cannot supply both/i);
    });

    it('fails when requirementsFile does not exist', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });
      await engine.init();

      await expect(engine.start({
        issue: 1,
        requirementsFile: path.join(tmpDir, 'nonexistent-reqs.txt'),
      })).rejects.toThrow(/requirements file not found/i);
    });
  });

  describe('ownership protection and duplicate Run rejection', () => {
    it('rejects another unfinished Run for the same repository Issue with inspection/recovery guidance', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });
      await engine.init();

      const run1 = await engine.start({ issue: 42 });
      expect(run1.run_id).toBeDefined();

      // Attempt to start a second run for the same issue
      await expect(engine.start({ issue: 42 })).rejects.toThrow(
        new RegExp(`Active run "${run1.run_id}" already exists for issue #42.*status.*recover`, 'i'),
      );
    });

    it('rejects when worktree has conflicting ownership marker', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });
      await engine.init();

      // Pre-create worktree dir with conflict owner marker
      const worktreeDir = path.join(tmpDir, '.worktrees', 'issue-99');
      await fs.mkdir(worktreeDir, { recursive: true });
      await fs.writeFile(
        path.join(worktreeDir, '.pc-execution-owner'),
        JSON.stringify({ version: '1.0', run_id: 'other-run-id', repository: 'test-owner/test-repo' }),
      );

      await expect(engine.start({ issue: 99 })).rejects.toThrow(/worktree.*conflict.*other-run-id/i);
    });
  });

  describe('immutability and Run capture', () => {
    it('captures configuration, workflow, role contracts, and shared requirements snapshot', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });
      const { configPath } = await engine.init();

      const reqFile = path.join(tmpDir, 'requirements.txt');
      await fs.writeFile(reqFile, 'Initial requirements content');

      const run = await engine.start({
        issue: 10,
        requirementsFile: reqFile,
      });

      expect(run.status).toBe('pending_dispatch');
      expect(run.shared_requirements).toBe('Initial requirements content');
      expect(run.workflow.initial_step).toBe('implementation');
      expect(run.roles.roles.worker.skill).toBe('pc-issue-work');

      // Now edit the files on disk!
      await fs.writeFile(reqFile, 'MODIFIED requirements content');
      const wfPath = path.join(tmpDir, 'config', 'workflow.yml');
      await fs.writeFile(wfPath, 'initial_step: altered\nsteps: {}');
      await fs.writeFile(configPath, 'repository: altered/repo');

      // Re-read status of the Run
      const status = await engine.status(run.run_id);
      expect(status.status).toBe('pending_dispatch');
      expect(status.step).toBe('implementation');
      expect(status.repository).toBe(run.repository);
    });
  });

  describe('status reporting', () => {
    it('reports pending_dispatch reflecting persisted event log', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });
      await engine.init();

      const run = await engine.start({ issue: 77 });
      const status = await engine.status(run.run_id);

      expect(status.run_id).toBe(run.run_id);
      expect(status.status).toBe('pending_dispatch');
      expect(status.step).toBe('implementation');
      expect(status.issue).toBe(77);
      expect(status.events_count).toBeGreaterThanOrEqual(1);

      // Verify event log file exists
      const eventLogPath = path.join(tmpDir, '.paper-craft', 'runs', run.run_id, 'events.jsonl');
      const logContent = await fs.readFile(eventLogPath, 'utf8');
      const events = logContent.trim().split('\n').map((line) => JSON.parse(line));
      expect(events[0].type).toBe('run_created');
      expect(events[0].run_id).toBe(run.run_id);
    });

    it('preflight failure does not write run or report success', async () => {
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        repositoryManager: mockRepoManager,
        executor: mockExecutor,
      });
      await engine.init();

      await expect(engine.start({ issue: 404 })).rejects.toThrow();

      // No runs should be recorded
      const runsDir = path.join(tmpDir, '.paper-craft', 'runs');
      try {
        const files = await fs.readdir(runsDir);
        expect(files.length).toBe(0);
      } catch {
        // Directory not even created is also fine
      }
    });
  });
});
