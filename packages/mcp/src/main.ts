#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Library } from '@paper-craft/core';
import { mustGetNexusPath } from '@paper-craft/core/utils/config';
import { createServer } from './index.js';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(
    'Usage: pc-mcp\n\nServe local library queries over MCP stdio.\nUses PC_NEXUS_PATH or the existing pc configuration.\nNo data-writing tools are exposed.',
  );
} else if (args.length > 0) {
  console.error(`Unexpected arguments: ${args.join(' ')}. Use pc-mcp --help.`);
  process.exitCode = 1;
} else {
  try {
    const server = createServer(new Library(mustGetNexusPath()));
    await server.connect(new StdioServerTransport());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
