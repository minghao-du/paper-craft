import { test, expect } from 'vitest';
import {
  finalizeEpic,
  type EpicFinalization,
} from '../../packages/core/src/workflow/epic-finalization.js';

const context = {
  head: 'a'.repeat(40),
  checkout: '/snapshot',
  terminalSession: 'fleet',
  changes: 'merged workflow script',
};
const receipt = {
  head: context.head,
  status: 'completed' as const,
  evidence: ['verified run'],
  blockers: [] as string[],
  scope: ['rule'],
  checks: ['production smoke'],
  artifacts: ['/smoke/result'],
  limitations: [],
};

test.each(['blocked', 'wrong SHA', 'missing evidence'])(
  '%s pipeline receipt prevents research writing',
  async (failure) => {
    const state: EpicFinalization = { context };
    const roles: string[] = [];
    await expect(
      finalizeEpic(
        state,
        'original goal',
        async (role) => {
          roles.push(role);
          if (role === 'epic')
            return JSON.stringify({
              pipeline: { run: true, reason: 'changed script' },
              research: { run: true, reason: 'new findings' },
              coordinator: {
                identity: 'coordinator',
                entry: '/research/research-state/RESEARCH-STATE.local.md',
                brief: 'confirmed findings',
              },
            });
          return JSON.stringify({
            ...receipt,
            ...(failure === 'blocked'
              ? { status: 'blocked', blockers: ['smoke failed'] }
              : failure === 'wrong SHA'
                ? { head: 'other' }
                : { evidence: [] }),
          });
        },
        () => {},
      ),
    ).rejects.toThrow();
    expect(roles).toEqual(['epic', 'pipeline-audit']);
  },
);

test('professional unaffected-scope evidence reuses prior audit after unrelated integration changes', async () => {
  const prior: EpicFinalization = {
    context,
    pipeline: receipt,
    research: { status: 'skipped', reason: 'No scientific impact' },
  };
  const state: EpicFinalization = { context: { ...context, head: 'b'.repeat(40) } };
  const roles: string[] = [];
  await finalizeEpic(
    state,
    'original goal',
    async (role) => {
      roles.push(role);
      return JSON.stringify({
        pipeline: {
          run: true,
          reuse: true,
          reason: 'Only unrelated README changed since prior smoke',
        },
        research: { run: false, reason: 'No scientific impact' },
      });
    },
    () => {},
    prior,
  );
  expect(roles).toEqual(['epic']);
  expect(state.pipeline).toMatchObject({
    status: 'completed',
    head: state.context.head,
    checks: ['production smoke'],
  });
  expect(
    state.pipeline && 'limitations' in state.pipeline && state.pipeline.limitations.join(' '),
  ).toContain(context.head);
});
