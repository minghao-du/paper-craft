import { statSync } from 'node:fs';
import { readJsonl } from '../storage/jsonl.js';
import { PcDatabase, isDbStale } from '../storage/db.js';
import { ReferenceSchema } from '../models/reference.js';
import { ProjectSchema } from '../models/project.js';
import { RepoSchema } from '../models/repo.js';
import { refsPath, projectsPath, reposPath, dbPath, allJsonlPaths } from '../utils/config.js';

/** Local library queries shared by command-line and agent adapters. */
export class Library {
  private pending: Promise<unknown> = Promise.resolve();

  /** Bind queries to an existing nexus directory; host configuration stays outside the service. */
  constructor(private readonly nexusPath: string) {
    if (!statSync(nexusPath).isDirectory()) {
      throw new Error(`Expected a nexus directory: ${nexusPath}`);
    }
  }

  /** Search local references, refreshing the disposable index when needed. */
  searchReferences(query: string, limit = 50) {
    validateLimit(limit);
    return this.query((db) => db.searchRefs(query, limit));
  }

  /** Return references and the total count for CLI summaries. */
  listReferences(limit?: number) {
    if (limit !== undefined) validateLimit(limit);
    return this.query((db) => ({ references: db.listRefs(limit), total: db.countRefs() }));
  }

  /** Get one reference or throw an actionable missing-record error. */
  getReference(id: string) {
    return this.query((db) => {
      const reference = db.getRef(id);
      if (!reference) throw new Error(`Reference not found: ${id}`);
      return reference;
    });
  }

  /** Read research projects from their authoritative JSONL store. */
  listProjects() {
    return readJsonl(projectsPath(this.nexusPath), ProjectSchema);
  }

  /** Read tracked repositories, optionally restricted to a project. */
  async listRepos(project?: string) {
    const repos = await readJsonl(reposPath(this.nexusPath), RepoSchema);
    return project ? repos.filter((repo) => repo.project === project) : repos;
  }

  private query<T>(operation: (db: PcDatabase) => T): Promise<T> {
    // A host may issue concurrent tool calls. Serialize index refreshes within this service.
    const result = this.pending.then(async () => {
      const path = dbPath(this.nexusPath);
      const stale = await isDbStale(path, allJsonlPaths(this.nexusPath));
      const db = await PcDatabase.open(path);
      try {
        if (stale) {
          const [references, projects, repos] = await Promise.all([
            readJsonl(refsPath(this.nexusPath), ReferenceSchema),
            this.listProjects(),
            this.listRepos(),
          ]);
          db.rebuildAll(references, projects, repos);
          await db.save(path);
        }
        return operation(db);
      } finally {
        db.close();
      }
    });
    this.pending = result.catch(() => undefined);
    return result;
  }
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`Expected a positive integer limit, received: ${limit}`);
  }
}
