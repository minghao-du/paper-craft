/**
 * `pc` — agent-first research workflow CLI.
 *
 * This is the entry point. It wires up the Commander.js command tree
 * and dispatches to command modules in src/commands/.
 */

import { Command } from 'commander';
import { registerConfigCommand } from '../../src/commands/config.js';
import { registerRebuildCommand } from '../../src/commands/rebuild.js';
import { registerProjectCommand } from '../../src/commands/project.js';
import { registerRepoCommand } from '../../src/commands/repo.js';
import { registerSearchCommand, registerListCommand, registerGetCommand } from '../../src/commands/search.js';
import { registerS2Command } from '../../src/commands/s2/index.js';

const VERSION = '0.1.0';

const program = new Command()
  .name('pc')
  .description('Agent-first research workflow CLI')
  .version(VERSION);

// Global flag: --human for human-readable output (default is JSON for agents)
program.option('--human', 'Use human-readable output instead of JSON', false);

// Helper to read the human flag from the root program
const opts = {
  human: () => program.opts()['human'] as boolean,
};

// Register commands
registerConfigCommand(program, opts);
registerRebuildCommand(program, opts);
registerProjectCommand(program, opts);
registerRepoCommand(program, opts);
registerSearchCommand(program, opts);
registerListCommand(program, opts);
registerGetCommand(program, opts);
registerS2Command(program, opts);

// Parse and execute
program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
