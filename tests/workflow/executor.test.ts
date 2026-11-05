import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgyExecutor } from '../../packages/core/src/workflow/executor.js';

describe('AgyExecutor Contract & Process Lifecycle (Ticket #3)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-executor-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('check()', () => {
    it('returns available: false when executable is missing', async () => {
      const executor = new AgyExecutor({ command: 'non-existent-agy-binary-xyz' });
      const res = await executor.check();
      expect(res.available).toBe(false);
      expect(res.error).toBeDefined();
      expect(res.error).toContain('non-existent-agy-binary-xyz');
    });

    it('returns available: true when command is executable', async () => {
      // Use node as a reliable command in test environment
      const executor = new AgyExecutor({ command: process.execPath });
      const res = await executor.check();
      expect(res.available).toBe(true);
      expect(res.error).toBeUndefined();
    });
  });

  describe('launch() and inspect()', () => {
    it('returns not_started for unknown task', async () => {
      const executor = new AgyExecutor();
      const inspection = await executor.inspect('unknown-task');
      expect(inspection.status).toBe('not_started');
    });

    it('launches a long-running process and inspects as running, then stops it', async () => {
      // A script that sleeps until signaled or killed
      const scriptPath = path.join(tmpDir, 'sleeper.js');
      await fs.writeFile(
        scriptPath,
        `
        process.stdin.resume();
        setInterval(() => {}, 1000);
        `,
        'utf8',
      );

      const executor = new AgyExecutor({
        command: process.execPath,
        extraArgs: [scriptPath],
        stopGracePeriodMs: 200,
      });

      const handle = await executor.launch('task-sleep-1', tmpDir, 'test-prompt');
      expect(handle.taskId).toBe('task-sleep-1');
      expect(handle.id).toMatch(/^agy-task-sleep-1-/);

      const inspection = await executor.inspect('task-sleep-1');
      expect(inspection.status).toBe('running');
      expect(inspection.handle?.taskId).toBe('task-sleep-1');

      // Stop and verify termination
      const stopResult = await executor.stop(handle);
      expect(stopResult.stopped).toBe(true);

      // Verify status is now exited
      const postStopInspection = await executor.inspect('task-sleep-1');
      expect(postStopInspection.status).toBe('exited');
    });

    it('inspects as exited when process terminates naturally', async () => {
      const scriptPath = path.join(tmpDir, 'quick-exit.js');
      await fs.writeFile(
        scriptPath,
        `
        process.exit(0);
        `,
        'utf8',
      );

      const executor = new AgyExecutor({
        command: process.execPath,
        extraArgs: [scriptPath],
      });

      const handle = await executor.launch('task-quick-1', tmpDir, 'prompt');
      expect(handle.taskId).toBe('task-quick-1');

      // Await process exit
      let inspection = await executor.inspect('task-quick-1');
      const start = Date.now();
      while (inspection.status === 'running' && Date.now() - start < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        inspection = await executor.inspect('task-quick-1');
      }

      expect(inspection.status).toBe('exited');
      expect(inspection.exitCode).toBe(0);
    });

    it('rejects launching duplicate taskId when already running', async () => {
      const scriptPath = path.join(tmpDir, 'sleep2.js');
      await fs.writeFile(scriptPath, 'setInterval(() => {}, 1000);', 'utf8');

      const executor = new AgyExecutor({
        command: process.execPath,
        extraArgs: [scriptPath],
      });

      const handle = await executor.launch('dup-task', tmpDir, 'prompt');
      expect(handle.taskId).toBe('dup-task');

      await expect(executor.launch('dup-task', tmpDir, 'prompt-2')).rejects.toThrow(
        /Task "dup-task" is already running/,
      );

      await executor.stop(handle);
    });
  });

  describe('send()', () => {
    it('sends input to the process stdin', async () => {
      const outputFile = path.join(tmpDir, 'received.txt');
      const scriptPath = path.join(tmpDir, 'echoer.js');
      await fs.writeFile(
        scriptPath,
        `
        const fs = require('fs');
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
          fs.appendFileSync(${JSON.stringify(outputFile)}, chunk);
        });
        setInterval(() => {}, 1000);
        `,
        'utf8',
      );

      const executor = new AgyExecutor({
        command: process.execPath,
        extraArgs: [scriptPath],
      });

      const handle = await executor.launch('task-send-1', tmpDir, 'prompt');
      await executor.send(handle, 'hello world');

      // Wait for Node process to receive input and write
      let content = '';
      for (let i = 0; i < 50; i++) {
        try {
          content = await fs.readFile(outputFile, 'utf8');
          if (content.includes('hello world')) break;
        } catch {
          // File not written yet
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(content).toContain('hello world');

      await executor.stop(handle);
    });

    it('throws error when sending to an exited or unknown process', async () => {
      const executor = new AgyExecutor();
      await expect(
        executor.send({ id: 'dummy', taskId: 'nonexistent-task' }, 'hello'),
      ).rejects.toThrow(/execution is not running/);
    });
  });

  describe('stop() idempotency', () => {
    it('returns stopped: true when stopping an already exited or unknown handle', async () => {
      const executor = new AgyExecutor();
      const res = await executor.stop({ id: 'unknown-id', taskId: 'unknown-task' });
      expect(res.stopped).toBe(true);
    });
  });
});
