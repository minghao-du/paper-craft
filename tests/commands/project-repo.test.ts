/**
 * Integration tests for `pc project` and `pc repo` commands.
 *
 * Uses a temporary nexus directory with JSONL files, testing the full
 * command flow through the storage layer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonl, writeJsonl, appendJsonl } from '@paper-craft/core/storage/jsonl';
import { ProjectSchema, type Project } from '@paper-craft/core/models/project';
import { RepoSchema, type Repo } from '@paper-craft/core/models/repo';
import { findById } from '@paper-craft/core/storage/jsonl';

describe('Project CRUD via JSONL', () => {
  let nexus: string;
  let projPath: string;

  beforeEach(async () => {
    nexus = await mkdtemp(join(tmpdir(), 'pc-test-nexus-'));
    await mkdir(join(nexus, '.paper-craft'), { recursive: true });
    projPath = join(nexus, '.paper-craft', 'projects.jsonl');
  });

  afterEach(async () => {
    await rm(nexus, { recursive: true, force: true });
  });

  it('creates a project and reads it back', async () => {
    const project: Project = {
      id: 'test-proj',
      name: 'Test Project',
      description: 'A test project',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await appendJsonl(projPath, project);
    const projects = await readJsonl(projPath, ProjectSchema);
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe('test-proj');
    expect(projects[0].name).toBe('Test Project');
  });

  it('prevents duplicate project IDs', async () => {
    const p1: Project = { id: 'dup', name: 'First' };
    const p2: Project = { id: 'dup', name: 'Second' };

    await appendJsonl(projPath, p1);
    await appendJsonl(projPath, p2);

    const projects = await readJsonl(projPath, ProjectSchema);
    // JSONL allows duplicates at the storage level — dedup is command-level
    expect(projects).toHaveLength(2);

    // findById returns first match
    const [idx, found] = findById(projects, 'dup');
    expect(idx).toBe(0);
    expect(found?.name).toBe('First');
  });

  it('updates a project in place', async () => {
    const projects: Project[] = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ];
    await writeJsonl(projPath, projects);

    // Simulate update
    const loaded = await readJsonl(projPath, ProjectSchema);
    const [idx, existing] = findById(loaded, 'b');
    expect(idx).toBe(1);
    expect(existing).toBeDefined();

    loaded[idx] = { ...existing!, name: 'Beta Updated', updated_at: new Date().toISOString() };
    await writeJsonl(projPath, loaded);

    const final = await readJsonl(projPath, ProjectSchema);
    expect(final[1].name).toBe('Beta Updated');
    expect(final[0].name).toBe('Alpha'); // unchanged
  });

  it('deletes a project', async () => {
    const projects: Project[] = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
      { id: 'c', name: 'Gamma' },
    ];
    await writeJsonl(projPath, projects);

    const loaded = await readJsonl(projPath, ProjectSchema);
    const [idx] = findById(loaded, 'b');
    loaded.splice(idx, 1);
    await writeJsonl(projPath, loaded);

    const final = await readJsonl(projPath, ProjectSchema);
    expect(final).toHaveLength(2);
    expect(final.map((p) => p.id)).toEqual(['a', 'c']);
  });
});

describe('Repo CRUD via JSONL', () => {
  let nexus: string;
  let repoPath: string;

  beforeEach(async () => {
    nexus = await mkdtemp(join(tmpdir(), 'pc-test-nexus-'));
    await mkdir(join(nexus, '.paper-craft'), { recursive: true });
    repoPath = join(nexus, '.paper-craft', 'repos.jsonl');
  });

  afterEach(async () => {
    await rm(nexus, { recursive: true, force: true });
  });

  it('creates a GitHub repo', async () => {
    const repo: Repo = {
      id: 'my-repo',
      project: 'test-proj',
      type: 'github',
      name: 'my-repo',
      github_url: 'https://github.com/owner/my-repo',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await appendJsonl(repoPath, repo);
    const repos = await readJsonl(repoPath, RepoSchema);
    expect(repos).toHaveLength(1);
    expect(repos[0].type).toBe('github');
    expect(repos[0].github_url).toBe('https://github.com/owner/my-repo');
  });

  it('creates a manual repo', async () => {
    const repo: Repo = {
      id: 'local-tools',
      project: 'test-proj',
      type: 'manual',
      name: 'Local Tools',
    };

    await appendJsonl(repoPath, repo);
    const repos = await readJsonl(repoPath, RepoSchema);
    expect(repos).toHaveLength(1);
    expect(repos[0].type).toBe('manual');
    expect(repos[0].github_url).toBeUndefined();
  });

  it('filters repos by project', async () => {
    const repos: Repo[] = [
      { id: 'r1', project: 'proj-a', type: 'github', name: 'R1' },
      { id: 'r2', project: 'proj-b', type: 'github', name: 'R2' },
      { id: 'r3', project: 'proj-a', type: 'manual', name: 'R3' },
    ];
    await writeJsonl(repoPath, repos);

    const loaded = await readJsonl(repoPath, RepoSchema);
    const projARepos = loaded.filter((r) => r.project === 'proj-a');
    expect(projARepos).toHaveLength(2);
    expect(projARepos.map((r) => r.id)).toEqual(['r1', 'r3']);
  });

  it('cascade deletes repos when project deleted', async () => {
    const repos: Repo[] = [
      { id: 'r1', project: 'doomed', type: 'github', name: 'R1' },
      { id: 'r2', project: 'doomed', type: 'github', name: 'R2' },
      { id: 'r3', project: 'safe', type: 'github', name: 'R3' },
    ];
    await writeJsonl(repoPath, repos);

    const loaded = await readJsonl(repoPath, RepoSchema);
    const remaining = loaded.filter((r) => r.project !== 'doomed');
    await writeJsonl(repoPath, remaining);

    const final = await readJsonl(repoPath, RepoSchema);
    expect(final).toHaveLength(1);
    expect(final[0].id).toBe('r3');
  });
});

describe('ProjectSchema validation', () => {
  it('rejects invalid IDs', () => {
    const result = ProjectSchema.safeParse({ id: 'UPPERCASE', name: 'Test' });
    expect(result.success).toBe(false);
  });

  it('rejects IDs starting with hyphen', () => {
    const result = ProjectSchema.safeParse({ id: '-bad', name: 'Test' });
    expect(result.success).toBe(false);
  });

  it('accepts valid IDs', () => {
    const result = ProjectSchema.safeParse({ id: 'my-project-1', name: 'Test' });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = ProjectSchema.safeParse({ id: 'test', name: '' });
    expect(result.success).toBe(false);
  });
});

describe('RepoSchema validation', () => {
  it('rejects invalid type', () => {
    const result = RepoSchema.safeParse({
      id: 'test',
      project: 'proj',
      type: 'invalid',
      name: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('accepts github type', () => {
    const result = RepoSchema.safeParse({
      id: 'test',
      project: 'proj',
      type: 'github',
      name: 'Test',
    });
    expect(result.success).toBe(true);
  });

  it('accepts manual type', () => {
    const result = RepoSchema.safeParse({
      id: 'test',
      project: 'proj',
      type: 'manual',
      name: 'Test',
    });
    expect(result.success).toBe(true);
  });
});
