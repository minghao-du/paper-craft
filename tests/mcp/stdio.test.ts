import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const entry = resolve('packages/mcp/dist/main.js');
const cli = resolve('packages/cli/dist/main.js');
const reference = {
  id: 'paper-1',
  doi: '',
  title: 'Bird morphology',
  authors: [],
  abstract: '',
  venue: '',
  published: { year: 2026 },
  pdf_path: '',
  source: { type: 'manual', id: 'paper-1' },
};
const projects = [
  { id: 'birds', name: 'Birds' },
  { id: 'other', name: 'Other' },
];
const repos = [
  { id: 'measure', project: 'birds', type: 'manual', name: 'Measurements' },
  { id: 'other', project: 'other', type: 'manual', name: 'Other' },
];

async function withServer(run: (client: Client, nexus: string) => Promise<void>) {
  const nexus = await mkdtemp(join(tmpdir(), 'pc-mcp-'));
  const client = new Client({ name: 'paper-craft-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: nexus,
    env: { PC_NEXUS_PATH: nexus },
    stderr: 'pipe',
  });
  try {
    await mkdir(join(nexus, '.paper-craft'));
    for (const [name, records] of Object.entries({ refs: [reference], projects, repos })) {
      await writeFile(
        join(nexus, '.paper-craft', `${name}.jsonl`),
        records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
    }
    await client.connect(transport);
    await run(client, nexus);
  } finally {
    await client.close();
    await transport.close();
    await rm(nexus, { recursive: true, force: true });
  }
}

it('discovers query tools and returns the same local data as the compiled CLI', async () => {
  await withServer(async (client, nexus) => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_reference',
      'list_projects',
      'list_repos',
      'search_references',
    ]);
    const refsFile = join(nexus, '.paper-craft/refs.jsonl');
    const before = await readFile(refsFile, 'utf8');
    const calls = [
      [
        'search_references',
        { query: 'Bird', limit: 1 },
        ['search', 'Bird', '--limit', '1'],
        [reference],
      ],
      ['get_reference', { id: 'paper-1' }, ['get', 'paper-1'], reference],
      ['list_projects', {}, ['project', 'list'], projects],
      ['list_repos', { project: 'birds' }, ['repo', 'list', '--project', 'birds'], [repos[0]]],
    ] as const;
    for (const [name, args, cliArgs, expected] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }]);
      const output = execFileSync(process.execPath, [cli, ...cliArgs], {
        cwd: nexus,
        env: { ...process.env, PC_NEXUS_PATH: nexus },
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(JSON.parse(output)).toEqual(expected);
    }
    expect(await readFile(refsFile, 'utf8')).toBe(before);
    const updated = { ...reference, title: 'Updated morphology' };
    await writeFile(refsFile, JSON.stringify(updated) + '\n');
    const newer = new Date(Date.now() + 2000);
    await utimes(refsFile, newer, newer);
    const result = await client.callTool({ name: 'get_reference', arguments: { id: 'paper-1' } });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(updated) }]);
  });
}, 20000);

it('reports invalid input, missing records and malformed data without losing the session', async () => {
  await withServer(async (client, nexus) => {
    const missing = await client.callTool({ name: 'get_reference', arguments: { id: 'absent' } });
    expect(missing.isError).toBe(true);
    expect(missing.content).toEqual([{ type: 'text', text: 'Reference not found: absent' }]);
    const invalid = await client.callTool({
      name: 'search_references',
      arguments: { query: 'Bird', limit: -1 },
    });
    expect(invalid.isError).toBe(true);
    await writeFile(join(nexus, '.paper-craft/projects.jsonl'), '{broken}\n');
    const malformed = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(malformed.isError).toBe(true);
    expect(malformed.content).toEqual([
      { type: 'text', text: 'JSONL parse error on line 1: invalid JSON' },
    ]);
    const recovered = await client.callTool({ name: 'list_repos', arguments: {} });
    expect(recovered.isError).not.toBe(true);
    expect(recovered.content).toEqual([{ type: 'text', text: JSON.stringify(repos) }]);
  });
}, 20000);

it('fails startup visibly for an invalid nexus without polluting the protocol stream', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pc-mcp-invalid-'));
  try {
    const result = spawnSync(process.execPath, [entry], {
      cwd: temporary,
      env: { ...process.env, PC_NEXUS_PATH: join(temporary, 'missing') },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Configured nexus_path does not exist:');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 10000);
