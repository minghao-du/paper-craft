import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../packages/cli/src/workflow.js';

describe('Workflow CLI smoke tests (Ticket #2)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-cli-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('prints help message for workflow command', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(['workflow', '--help'], {
      cwd: tmpDir,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    });

    expect(exitCode).toBe(0);
    const output = stdout.join('\n');
    expect(output).toContain('Usage: pc workflow <command>');
    expect(output).toContain('init');
    expect(output).toContain('start');
    expect(output).toContain('status');
  });

  it('runs workflow init to create config', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(['workflow', 'init', '--repo', 'test-org/test-repo'], {
      cwd: tmpDir,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    });

    expect(exitCode).toBe(0);
    const configPath = path.join(tmpDir, '.pc-workflow.yml');
    const exists = await fs.stat(configPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(configPath, 'utf8');
    expect(content).toContain('repository: test-org/test-repo');
  });

  it('returns non-zero exit code and error message on preflight failure', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    // Run without init or missing issue number
    const exitCode = await runCli(['workflow', 'start'], {
      cwd: tmpDir,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Issue number is required');
  });

  it('runs workflow start and status commands end-to-end with mock engine', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    // 1. Init workflow
    await runCli(['workflow', 'init', '--repo', 'acme/anvil'], {
      cwd: tmpDir,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    });

    // Create engine with injected mock checkers
    const { WorkflowEngine } = await import('../../packages/core/src/workflow/engine.js');
    const engine = new WorkflowEngine({
      cwd: tmpDir,
      issueChecker: {
        checkIssue: async () => ({ exists: true, open: true, title: 'Mock issue' }),
      },
      providerChecker: {
        check: async () => ({ available: true }),
      },
    });

    stdout.length = 0;
    stderr.length = 0;

    // 2. Start workflow
    const startCode = await runCli(['workflow', 'start', '123', '--requirements', 'Must be solid iron'], {
      cwd: tmpDir,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
      engine,
    });

    expect(startCode).toBe(0);
    const startOutput = JSON.parse(stdout.join('\n'));
    expect(startOutput.run_id).toBeDefined();
    expect(startOutput.status).toBe('pending_dispatch');
    expect(startOutput.issue).toBe(123);
    expect(startOutput.repository).toBe('acme/anvil');

    stdout.length = 0;
    stderr.length = 0;

    // 3. Status command (using 'orchestrator status' alias)
    const statusCode = await runCli(['workflow', 'orchestrator', 'status'], {
      cwd: tmpDir,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
      engine,
    });

    expect(statusCode).toBe(0);
    const statusOutput = JSON.parse(stdout.join('\n'));
    expect(statusOutput.run_id).toBe(startOutput.run_id);
    expect(statusOutput.status).toBe('pending_dispatch');
    expect(statusOutput.issue).toBe(123);
    expect(statusOutput.step).toBe('implementation');
  });
});
