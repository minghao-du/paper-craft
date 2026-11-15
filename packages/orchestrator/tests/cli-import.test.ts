/**
 * CLI Import Side-Effect Isolation Tests.
 *
 * Verifies that importing cli.ts and envelope-cli.ts executes with zero side effects:
 * - Does not trigger command execution or arg parsing
 * - Does not write to stdout or stderr
 * - Does not mutate process.exitCode
 * - Exposes callable main() and helper exports
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('Orchestrator CLI Import Isolation', () => {
  it('importing cli.ts has no execution side effects and preserves helper exports', async () => {
    const originalExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const cliModule = await import('../src/cli.js');

      expect(cliModule).toBeDefined();
      expect(typeof cliModule.main).toBe('function');
      expect(typeof cliModule.loadDispatchRequest).toBe('function');
      expect(typeof cliModule.readReportText).toBe('function');

      // Verify no side effects occurred on import
      expect(process.exitCode).toBe(originalExitCode);
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();

      // Verify main can be invoked programmatically without process.exit
      const exitCode = await cliModule.main([]);
      expect(exitCode).toBe(1);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('importing envelope-cli.ts has no execution side effects and exports main', async () => {
    const originalExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const envelopeModule = await import('../src/envelope-cli.js');

      expect(envelopeModule).toBeDefined();
      expect(typeof envelopeModule.main).toBe('function');

      // Verify no side effects occurred on import
      expect(process.exitCode).toBe(originalExitCode);
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();

      // Verify main can be invoked programmatically without process.exit
      const exitCode = await envelopeModule.main([]);
      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('readReportText handles inline JSON and file paths', async () => {
    const { readReportText } = await import('../src/cli.js');
    expect(readReportText('  {"execution_status": "succeeded"}  ')).toBe(
      '{"execution_status": "succeeded"}',
    );

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-report-test-'));
    try {
      const reportFile = path.join(tempDir, 'report.json');
      fs.writeFileSync(reportFile, '{"execution_status": "failed"}', 'utf8');
      expect(readReportText(reportFile)).toBe('{"execution_status": "failed"}');

      expect(() =>
        readReportText(path.join(tempDir, 'nonexistent.json')),
      ).toThrow('Report file not found');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
