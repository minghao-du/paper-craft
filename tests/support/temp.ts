import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Creates an isolated temporary directory for test fixtures.
 */
export function createTestDir(prefix = 'pc-test-'): {
  dir: string;
  cleanup: () => void;
} {
  const rawTempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const tempDir = fs.realpathSync(rawTempDir);
  const cleanup = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignored during cleanup
    }
  };
  return { dir: tempDir, cleanup };
}
