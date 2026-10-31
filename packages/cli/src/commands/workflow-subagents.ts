/** Temporary delegation CLI shared by all core roles. */
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';
import { Subagents, CodexShortRunner, type ShortInput } from '@paper-craft/core/workflow/subagents';
import { output } from '../utils/output.js';
/** Register queue, execution and persisted-result operations. */
export function registerSubagentCommands(workflow: Command, opts: { human: () => boolean }): void {
  const group = workflow
    .command('subagent')
    .description('Delegate temporary read/write work; parent retains ownership');
  for (const operation of [
    'create',
    'list',
    'get',
    'dispatch',
    'wait',
    'cancel',
    'reconcile',
    'collect',
    'cleanup',
    'handoff',
  ]) {
    group
      .command(operation)
      .option('--config <file>', 'Authoritative Fleet configuration', '.epic-config.json')
      .option('--timeout-ms <number>', 'Bounded wait; timeout preserves execution occupancy')
      .option('--id <uuid>', 'Task identity')
      .option('--input <file>', 'JSON task request (parent, checkout, mode, brief, files)')
      .option('--issue <number>', 'Worker Issue for Orchestrator handoff')
      .option('--fleet-limit <number>', 'Fleet concurrency limit', '4')
      .option('--parent-limit <number>', 'Parent concurrency limit', '2')
      .action(
        async (o: {
          config: string;
          id?: string;
          timeoutMs?: string;
          input?: string;
          issue?: string;
          fleetLimit: string;
          parentLimit: string;
        }) => {
          try {
            const manager = new Subagents(loadFleetConfig(o.config), {
              fleet: Number(o.fleetLimit),
              parent: Number(o.parentLimit),
            });
            let result: unknown;
            if (operation === 'create') {
              if (!o.input) throw new Error('Expected --input JSON task request');
              result = manager.create(JSON.parse(readFileSync(o.input, 'utf8')) as ShortInput);
            } else if (operation === 'list') result = manager.list();
            else if (operation === 'dispatch') {
              await manager.dispatch(new CodexShortRunner());
              result = manager.list();
            } else {
              if (!o.id) throw new Error('Expected --id task identity');
              switch (operation) {
                case 'get':
                  result = manager.get(o.id);
                  break;
                case 'wait':
                  result = await manager.wait(
                    o.id,
                    o.timeoutMs === undefined ? undefined : Number(o.timeoutMs),
                  );
                  break;
                case 'cancel':
                  result = await manager.cancel(o.id, new CodexShortRunner());
                  break;
                case 'reconcile':
                  result = await manager.reconcile(o.id, new CodexShortRunner());
                  break;
                case 'collect':
                  result = manager.collect(o.id);
                  break;
                case 'cleanup':
                  manager.cleanup(o.id);
                  result = manager.get(o.id);
                  break;
                case 'handoff':
                  result = manager.handoff(o.id, Number(o.issue));
              }
            }
            output(result, opts.human());
          } catch (error) {
            output(
              { status: 'unknown', error: error instanceof Error ? error.message : String(error) },
              false,
            );
            process.exitCode = 2;
          }
        },
      );
  }
}
