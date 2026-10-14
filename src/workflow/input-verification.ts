/**
 * Prerequisite input verification protocol for issue workflows.
 *
 * Verifies that required input models, data tables, and external files exist
 * on disk before execution/coding proceeds. If any prerequisite is missing,
 * halts immediately with a standardized 3-part interactive halt notification.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * Specification for a required input file or external artifact.
 */
export interface PrerequisiteInput {
  /** Relative or absolute path to the required file. */
  path: string;
  /** Description of the operation, script, or verification step that requires this file. */
  operation: string;
  /** Optional human-readable description or context. */
  description?: string;
}

/**
 * Configuration options for input verification.
 */
export interface InputVerificationOptions {
  /** Base directory against which relative paths are resolved. Defaults to process.cwd(). */
  baseDir?: string;
}

/**
 * Result of checking prerequisite inputs against the filesystem.
 */
export interface VerificationResult {
  /** True if all prerequisite inputs exist on disk. */
  ok: boolean;
  /** List of prerequisite inputs that were not found on disk. */
  missing: PrerequisiteInput[];
  /** Formatted 3-part interactive halt message if missing inputs were detected. */
  haltMessage?: string;
}

/**
 * Standard prefix for the missing input halt notification.
 */
export const HALT_HEADER = '🚨 缺少前置依赖输入文件，无法继续执行任务：';

/**
 * Standard call-to-action prompt for the missing input halt notification.
 */
export const HALT_ACTION_PROMPT =
  '- 请操作: 请将该文件放置在上述指定路径，或者告知替代的 mock 方案 / 是否授权重新生成？';

/**
 * Format a single or list of missing prerequisite inputs into the standardized 3-part notification.
 *
 * Format:
 * 🚨 缺少前置依赖输入文件，无法继续执行任务：
 * - 缺失文件及预期路径: `<relative/path/to/file>`
 * - 依赖该文件的操作: `<说明是哪个评测脚本/验证步骤需要它>`
 * - 请操作: 请将该文件放置在上述指定路径，或者告知替代的 mock 方案 / 是否授权重新生成？
 *
 * @param missing One or more missing prerequisite inputs.
 * @param options Formatting options.
 * @returns Standardized halt notification string.
 */
export function formatMissingInputNotification(
  missing: PrerequisiteInput | PrerequisiteInput[],
  options?: InputVerificationOptions,
): string {
  void options;
  const items = Array.isArray(missing) ? missing : [missing];
  if (items.length === 0) {
    return '';
  }

  const lines = [HALT_HEADER];

  for (const item of items) {
    let cleanPath = item.path.trim();
    if (cleanPath.startsWith('`') && cleanPath.endsWith('`')) {
      cleanPath = cleanPath.slice(1, -1);
    }
    if (cleanPath.startsWith('<') && cleanPath.endsWith('>')) {
      cleanPath = cleanPath.slice(1, -1);
    }

    let cleanOp = item.operation.trim();
    if (cleanOp.startsWith('`') && cleanOp.endsWith('`')) {
      cleanOp = cleanOp.slice(1, -1);
    }
    if (cleanOp.startsWith('<') && cleanOp.endsWith('>')) {
      cleanOp = cleanOp.slice(1, -1);
    }

    lines.push(`- 缺失文件及预期路径: \`<${cleanPath}>\``);
    lines.push(`- 依赖该文件的操作: \`<${cleanOp}>\``);
  }

  lines.push(HALT_ACTION_PROMPT);
  return lines.join('\n');
}

/**
 * Verifies that all required prerequisite inputs exist locally on disk.
 *
 * @param requirements List of prerequisite inputs to verify.
 * @param options Verification options (e.g. custom base directory).
 * @returns Verification result containing status, list of missing items, and halt message.
 */
export function verifyPrerequisiteInputs(
  requirements: PrerequisiteInput[],
  options?: InputVerificationOptions,
): VerificationResult {
  const baseDir = options?.baseDir ?? process.cwd();
  const missing: PrerequisiteInput[] = [];

  for (const req of requirements) {
    const resolvedPath = isAbsolute(req.path) ? req.path : join(baseDir, req.path);
    if (!existsSync(resolvedPath)) {
      missing.push(req);
    }
  }

  if (missing.length === 0) {
    return {
      ok: true,
      missing: [],
    };
  }

  return {
    ok: false,
    missing,
    haltMessage: formatMissingInputNotification(missing, options),
  };
}

/**
 * Error thrown when a workflow halts due to missing prerequisite inputs.
 */
export class MissingInputHaltError extends Error {
  /** The missing prerequisite inputs that caused the halt. */
  readonly missing: PrerequisiteInput[];
  /** The formatted 3-part interactive halt notification. */
  readonly haltNotification: string;

  constructor(missing: PrerequisiteInput[], haltNotification: string) {
    super(haltNotification);
    this.name = 'MissingInputHaltError';
    this.missing = missing;
    this.haltNotification = haltNotification;
  }
}

/**
 * Asserts that all prerequisite inputs exist on disk.
 * If any prerequisite is missing, halts execution immediately by throwing a MissingInputHaltError.
 *
 * @param requirements List of prerequisite inputs.
 * @param options Verification options.
 * @throws {MissingInputHaltError} When one or more prerequisite files are missing.
 */
export function assertPrerequisiteInputs(
  requirements: PrerequisiteInput[],
  options?: InputVerificationOptions,
): void {
  const result = verifyPrerequisiteInputs(requirements, options);
  if (!result.ok) {
    throw new MissingInputHaltError(result.missing, result.haltMessage ?? '');
  }
}

