import { test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');
const skillsDir = resolve(repoRoot, 'skills');

test('pc-pr-check skill is retired and merged into pc-pr-review', () => {
  const prCheckPath = resolve(skillsDir, 'pc-pr-check');
  expect(existsSync(prCheckPath), 'skills/pc-pr-check should be deleted').toBe(false);

  const constEn = readFileSync(resolve(repoRoot, 'docs/constitution/CONSTITUTION.md'), 'utf8');
  const constZh = readFileSync(resolve(repoRoot, 'docs/constitution/CONSTITUTION.zh.md'), 'utf8');
  expect(constEn).not.toContain('/pc-pr-check');
  expect(constZh).not.toContain('/pc-pr-check');

  const prReview = readFileSync(resolve(skillsDir, 'pc-pr-review/SKILL.md'), 'utf8');
  expect(prReview).toContain('git status --short -uall');
  expect(prReview.toLowerCase()).toContain('pr title');
  expect(prReview.toLowerCase()).toContain('squashed');
});

test('legacy finalization.md protocol files are removed', () => {
  const snakemakeFinalization = resolve(skillsDir, 'pc-pipeline-snakemake/finalization.md');
  const researchStateFinalization = resolve(skillsDir, 'pc-research-state/finalization.md');
  expect(existsSync(snakemakeFinalization), 'pc-pipeline-snakemake/finalization.md should be removed').toBe(false);
  expect(existsSync(researchStateFinalization), 'pc-research-state/finalization.md should be removed').toBe(false);
});

test('specialist skills do not carry workflow or scheduling protocol traces', () => {
  const specialistSkills = [
    'pc-issue-file/SKILL.md',
    'pc-issue-next/SKILL.md',
    'pc-research-ideas/SKILL.md',
    'pc-research-plan/SKILL.md',
    'pc-pipeline-snakemake/SKILL.md',
    'pc-pr-review/SKILL.md',
    'pc-research-state/SKILL.md',
  ];

  for (const relPath of specialistSkills) {
    const fullPath = resolve(skillsDir, relPath);
    expect(existsSync(fullPath), `${relPath} should exist`).toBe(true);
    const content = readFileSync(fullPath, 'utf8');

    expect(content, `${relPath} must not reference submit-result`).not.toContain('submit-result');
    expect(content, `${relPath} must not reference pc workflow`).not.toContain('pc workflow');
    expect(content, `${relPath} must not reference workflow orchestrator dispatch`).not.toContain(
      'dispatched automatically by the workflow orchestrator',
    );
    expect(content, `${relPath} must not reference workflow engine`).not.toContain('workflow engine');
  }
});
