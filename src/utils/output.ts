/**
 * Shared output formatting for all commands.
 *
 * JSON is the default (agent-first). `--human` switches to readable text.
 */

/** Print a result as JSON or human-readable text. */
export function output(data: unknown, humanOutput: boolean, humanFormatter?: () => string): void {
  if (humanOutput && humanFormatter) {
    console.log(humanFormatter());
  } else {
    console.log(JSON.stringify(data, null, humanOutput ? 2 : 0));
  }
}

/** Print an error to stderr and exit. */
export function fatal(message: string, exitCode = 1): never {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}
