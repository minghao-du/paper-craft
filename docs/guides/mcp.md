# Local MCP integration

paper-craft exposes local library queries over MCP stdio. DeepSeek Harness can
load them through its official MCP client plugin. The server does not call a
model API and needs no DeepSeek API key; model configuration belongs to the host.

## Build and launch

From the paper-craft checkout, using Node.js 22 or newer and the pinned pnpm:

```sh
pnpm install
pnpm run build
node packages/mcp/dist/main.js --help
```

Configure the same nexus used by `pc`, either through `~/.config/pc/config.yml`
or `PC_NEXUS_PATH`. To launch explicitly:

```sh
PC_NEXUS_PATH=/absolute/path/to/nexus node /absolute/path/to/paper-craft/packages/mcp/dist/main.js
```

The process waits for an MCP client on stdin. Stdout carries protocol messages;
diagnostics go to stderr. Querying may rebuild the disposable index in the nexus
cache, but the tools do not change JSONL records. Start one server per nexus.
The workspace packages are local and private; these instructions do not assume
an npm publication.

## DeepSeek Harness

Use the official [`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)
plugin with this entry in your Harness profile's plugin configuration:

```yaml
- id: mcp-paper-craft
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: paper-craft
    transport: stdio
    command: /absolute/path/to/node
    args:
      - /absolute/path/to/paper-craft/packages/mcp/dist/main.js
    env:
      PC_NEXUS_PATH: /absolute/path/to/nexus
    failOnStartupError: true
```

Replace all absolute paths. `command -v node` identifies the Node executable.
Use an explicit nexus so launching the host from another directory cannot select
a different local library. Apply the entry through the host's configuration
mechanism and restart/reload the plugin. Harness configuration varies by release;
follow its [profile documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#profiles-and-bundles).

Ask the host to search your local library for a known title. Harness qualifies
names as `mcp__paper-craft__search_references`, for example.

| Tool | Arguments | Result |
| --- | --- | --- |
| `search_references` | `query`; optional `limit` (1–200, default 50) | Reference array |
| `get_reference` | `id` | One reference; error if absent |
| `list_projects` | none | Project array |
| `list_repos` | optional `project` ID | Repository array |

Results are JSON serialized in MCP text content. Invalid arguments, malformed
JSONL and missing references produce tool errors. These are metadata tools: they
do not read PDF contents, execute skills, schedule agents, or import data.
Existing `pc` commands remain available for those workflows.

## Package boundaries

- `@paper-craft/core` owns domain models, storage, workflow functions and the
  shared `Library` query service. Its public entry accepts an explicit nexus path
  and returns domain data or throws errors.
- `@paper-craft/cli` owns the `pc` entry, command parsing, terminal formatting and
  process exit behavior. Existing commands remain; the four MCP operations and
  reference listing share Core queries. Other command-specific orchestration is
  retained in CLI until another adapter needs it.
- `@paper-craft/mcp` owns tool schemas, MCP result formatting and stdio startup.
  It uses Core's public exports without invoking CLI or importing its internals.

A future DeepSeek native plugin can depend directly on `@paper-craft/core` and
register the same service methods through the host API. Keep host contexts,
credentials and lifecycle callbacks inside that adapter. A native UI or session
integration would be additional work. Core needs no plugin registry or knowledge
of the host. ESLint enforces the current dependency direction.

## Development and validation

`./pc` still runs the TypeScript source without a prior build. It enables the
workspace-only `paper-craft-source` export condition. Built packages use ordinary
JavaScript exports; each package compiles independently in dependency order.

```sh
pnpm run typecheck
pnpm run lint
pnpm test
```

Tests build first. MCP integration tests start the compiled server through the
official client over stdio, using temporary fixture data and comparing results
with the compiled CLI. They do not require a running DeepSeek host or model API.
