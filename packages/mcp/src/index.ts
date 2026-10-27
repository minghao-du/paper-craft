import { McpServer } from '@modelcontextprotocol/server';
import { Library } from '@paper-craft/core';
import { z } from 'zod';

/** Create a local query adapter without starting a transport or loading host configuration. */
export function createServer(library: Library): McpServer {
  const server = new McpServer({ name: 'paper-craft', version: '0.1.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool(
    'search_references',
    {
      description: 'Search the local paper-craft reference library by keyword.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations,
    },
    ({ query, limit }) => result(() => library.searchReferences(query, limit)),
  );
  server.registerTool(
    'get_reference',
    {
      description: 'Get a local reference by its exact ID.',
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations,
    },
    ({ id }) => result(() => library.getReference(id)),
  );
  server.registerTool(
    'list_projects',
    {
      description: 'List research projects in the local paper-craft nexus.',
      inputSchema: z.object({}),
      annotations,
    },
    () => result(() => library.listProjects()),
  );
  server.registerTool(
    'list_repos',
    {
      description: 'List tracked repositories, optionally filtered by project ID.',
      inputSchema: z.object({ project: z.string().min(1).optional() }),
      annotations,
    },
    ({ project }) => result(() => library.listRepos(project)),
  );
  return server;
}

async function result(operation: () => Promise<unknown>) {
  try {
    const data = await operation();
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
}
