#!/usr/bin/env node
/**
 * @fileoverview Main CLI entrypoint for paper-craft (pc).
 */

import { runCli } from './workflow.js';

const TOP_LEVEL_HELP = `
Usage: pc <command> [options]

Commands:
  workflow                 Manage and execute agent workflows
  help                     Show help for commands

Options:
  -h, --help               Show help information
  -v, --version            Show version information
`.trim();

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(TOP_LEVEL_HELP);
    process.exit(0);
  }

  if (command === '--version' || command === '-v') {
    console.log('paper-craft 0.1.0');
    process.exit(0);
  }

  if (command === 'workflow') {
    const exitCode = await runCli(argv);
    process.exit(exitCode);
  }

  console.error(`Unknown command: "${command}". Run "pc --help" for available commands.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
