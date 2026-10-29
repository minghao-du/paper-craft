/** Specialist contracts for post-merge EPIC finalization, using existing managed turns. */
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { IssueTurn } from './issue-driver.js';

const text = z.string().trim().min(1);
const disposition = z.object({ run: z.boolean(), reason: text, reuse: z.boolean().optional() });
const planSchema = z.object({
  pipeline: disposition,
  research: disposition,
  coordinator: z
    .object({
      identity: text,
      entry: text.refine(isAbsolute, 'Expected absolute research entry'),
      brief: text,
    })
    .optional(),
});
const receiptSchema = z.object({
  head: text,
  status: z.enum(['completed', 'blocked']),
  evidence: z.array(text).min(1),
  blockers: z.array(text),
  scope: z.array(text),
  checks: z.array(text),
  artifacts: z.array(text),
  limitations: z.array(text),
});
/** Verified integrated code and actual per-PR changes; never inferred from a single range. */
export interface FinalizationContext {
  head: string;
  checkout: string;
  terminalSession: string;
  changes: string;
  /** Additional local writing roots for the research writer only. */
  writableDirectories?: string[];
}
/** Durable specialist results supplement, rather than replace, managed attempt records. */
export interface EpicFinalization {
  context: FinalizationContext;
  /** Distinguishes explicit retries at the same integrated SHA. */
  round?: string;
  plan?: z.infer<typeof planSchema>;
  pipeline?: z.infer<typeof receiptSchema> | { status: 'skipped'; reason: string };
  research?: z.infer<typeof receiptSchema> | { status: 'skipped'; reason: string };
}
/** Sequentially obtain professional applicability and verified specialist results. */
export async function finalizeEpic(
  state: EpicFinalization,
  objective: string,
  turn: (role: IssueTurn['role'], brief: string, context?: FinalizationContext) => Promise<string>,
  save: () => void,
  previous?: EpicFinalization,
): Promise<void> {
  const context = JSON.stringify({ ...state.context, round: state.round });
  state.plan ??= planSchema.parse(
    JSON.parse(
      await turn(
        'epic',
        `Read project AGENTS.md and load finalization.md from the installed /pc-conductor skill directory. Confirm applicability for post-merge EPIC finalization against original objective ${objective}. Verified context ${context}. Previous round ${JSON.stringify(previous)}. Compare intervening changes; set reuse:true only for a previously completed specialist whose checks and conclusions remain unaffected, with concrete evidence in reason. Inspect actual PR paths and dependencies. Reply only JSON {"pipeline":{"run":true,"reason":"scope evidence"},"research":{"run":true,"reason":"scientific impact evidence"},"coordinator":{"identity":"designated Project coordinator","entry":"absolute shared research entry","brief":"coordinator-provided or confirmed judgments, evidence and requested updates"}}. Omit coordinator only when research is skipped. Do not assume coordination authority: unresolved coordinator or scientific decisions must block, not be invented. Only skip with concrete evidence.`,
      ),
    ),
  );
  save();
  if (state.plan.research.run && !state.plan.coordinator)
    throw new Error(
      'Research finalization requires designated coordinator and confirmed writing brief',
    );
  const schema =
    'Reply only JSON {"head":"evaluated integration SHA","status":"completed|blocked","evidence":["inspected evidence locations"],"blockers":[],"scope":[],"checks":[],"artifacts":[],"limitations":[]}. Account for every required check and requested update. Missing required evidence is blocking; retain unresolved research questions explicitly without promoting them to conclusions.';
  for (const kind of ['pipeline', 'research'] as const) {
    const decision = state.plan[kind];
    if (!state[kind]) {
      if (decision.reuse) {
        const prior = previous?.[kind];
        if (!decision.run || !prior || prior.status !== 'completed' || prior.blockers.length)
          throw new Error(
            'Reuse requires a previously completed specialist and unaffected-scope evidence',
          );
        state[kind] = {
          ...prior,
          head: state.context.head,
          limitations: [
            ...prior.limitations,
            `Reused from ${previous!.context.head}: ${decision.reason}`,
          ],
        };
      } else if (!decision.run) state[kind] = { status: 'skipped', reason: decision.reason };
      else {
        const skill = kind === 'pipeline' ? 'pc-pipeline-snakemake' : 'pc-research-state';
        const raw = await turn(
          kind === 'pipeline' ? 'pipeline-audit' : 'research-state',
          `Read project AGENTS.md and load finalization.md from the installed /pc-conductor skill directory; invoke /${skill} for EPIC post-merge finalization. Objective ${objective}. Context ${context}. Applicability ${decision.reason}. ${
            kind === 'pipeline'
              ? 'Read finalization.md from the installed /pc-pipeline-snakemake skill directory. Audit only affected dependency scope; preserve source/config/existing scientific outputs, isolate smoke artifacts. Findings return to existing EPIC/Worker repair flow.'
              : `Coordinator-approved writing brief ${JSON.stringify(state.plan.coordinator)}. Pipeline result ${JSON.stringify(state.pipeline)}. Coordinate serial writing with that designated Project coordinator, including other Fleets; do not write until prior writer has returned. Read finalization.md from the installed /pc-research-state skill directory.`
          } ${schema}`,
          kind === 'research'
            ? { ...state.context, writableDirectories: [dirname(state.plan.coordinator!.entry)] }
            : state.context,
        );
        state[kind] = receiptSchema.parse(JSON.parse(raw));
        save();
      }
      save();
    }
    const receipt = state[kind]!;
    if (
      receipt.status !== 'skipped' &&
      (receipt.head !== state.context.head ||
        receipt.status !== 'completed' ||
        receipt.blockers.length)
    )
      throw new Error(
        `${kind} finalization blocked or evaluated a different SHA; retain original attempt and route repair through EPIC`,
      );
  }
}
