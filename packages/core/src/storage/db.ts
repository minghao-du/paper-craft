/**
 * SQLite query layer backed by sql.js (WASM).
 *
 * The SQLite database is an ephemeral cache rebuilt from JSONL source files.
 * It exists solely to support efficient queries (search, filter, FTS).
 * The rebuild is lazy — only triggered when a query command detects the DB
 * is stale (JSONL mtime > DB mtime).
 */

import initSqlJs, { type Database } from 'sql.js';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Reference } from '../models/reference.js';
import type { Project } from '../models/project.js';
import type { Repo } from '../models/repo.js';

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

/** Lazily initialize the sql.js WASM module (cached across calls). */
async function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs();
  }
  return sqlPromise;
}

/** Result of a rebuild operation. */
export interface RebuildResult {
  status: string;
  references: number;
  projects: number;
  repos: number;
}

/** Wrapper around sql.js Database with paper-craft schema. */
export class PcDatabase {
  private constructor(private db: Database) {}

  /** Open (or create) a database from a file path. */
  static async open(dbPath: string): Promise<PcDatabase> {
    const SQL = await getSql();
    let db: Database;
    try {
      const buffer = await readFile(dbPath);
      db = new SQL.Database(buffer);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        db = new SQL.Database();
      } else {
        throw err;
      }
    }
    const pcDb = new PcDatabase(db);
    pcDb.createSchema();
    return pcDb;
  }

  /** Create an in-memory database (useful for tests). */
  static async inMemory(): Promise<PcDatabase> {
    const SQL = await getSql();
    const db = new SQL.Database();
    const pcDb = new PcDatabase(db);
    pcDb.createSchema();
    return pcDb;
  }

  /** Persist the database to disk. */
  async save(dbPath: string): Promise<void> {
    await mkdir(dirname(dbPath), { recursive: true });
    const data = this.db.export();
    await writeFile(dbPath, Buffer.from(data));
  }

  /** Close the database and free WASM memory. */
  close(): void {
    this.db.close();
  }

  /** Rebuild all tables from JSONL data. Returns counts per entity. */
  rebuildAll(refs: Reference[], projects: Project[], repos: Repo[]): RebuildResult {
    this.db.run('DROP TABLE IF EXISTS refs');
    this.db.run('DROP TABLE IF EXISTS projects');
    this.db.run('DROP TABLE IF EXISTS repos');
    this.createSchema();

    for (const ref of refs) {
      this.insertRef(ref);
    }
    for (const project of projects) {
      this.insertProject(project);
    }
    for (const repo of repos) {
      this.insertRepo(repo);
    }

    return {
      status: 'ok',
      references: refs.length,
      projects: projects.length,
      repos: repos.length,
    };
  }

  /** Search references by keyword across title, abstract, venue, authors. */
  searchRefs(query: string, limit = 50): Reference[] {
    const pattern = `%${query}%`;
    const stmt = this.db.prepare(`
      SELECT data FROM refs
      WHERE title LIKE :pattern
         OR abstract LIKE :pattern
         OR venue LIKE :pattern
         OR authors LIKE :pattern
      LIMIT :limit
    `);
    stmt.bind({ ':pattern': pattern, ':limit': limit });
    const results: Reference[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push(JSON.parse(row['data'] as string) as Reference);
    }
    stmt.free();
    return results;
  }

  /** List all references with optional limit. */
  listRefs(limit?: number): Reference[] {
    const sql = limit ? `SELECT data FROM refs LIMIT ${limit}` : 'SELECT data FROM refs';
    const stmt = this.db.prepare(sql);
    const results: Reference[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push(JSON.parse(row['data'] as string) as Reference);
    }
    stmt.free();
    return results;
  }

  /** Get a reference by ID. */
  getRef(id: string): Reference | undefined {
    const stmt = this.db.prepare('SELECT data FROM refs WHERE id = :id');
    stmt.bind({ ':id': id });
    let result: Reference | undefined;
    if (stmt.step()) {
      const row = stmt.getAsObject();
      result = JSON.parse(row['data'] as string) as Reference;
    }
    stmt.free();
    return result;
  }

  /** Count all references. */
  countRefs(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM refs');
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    return row['count'] as number;
  }

  // -- Private helpers --

  private createSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS refs (
        id TEXT PRIMARY KEY,
        doi TEXT,
        title TEXT,
        abstract TEXT,
        venue TEXT,
        authors TEXT,
        pub_year INTEGER,
        data TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT,
        data TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        project TEXT,
        name TEXT,
        data TEXT NOT NULL
      )
    `);
  }

  private insertRef(ref: Reference): void {
    const authorsText = ref.authors.map((a) => `${a.first} ${a.last}`).join(', ');
    this.db.run(
      'INSERT OR REPLACE INTO refs (id, doi, title, abstract, venue, authors, pub_year, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ref.id, ref.doi, ref.title, ref.abstract, ref.venue, authorsText, ref.published.year, JSON.stringify(ref)],
    );
  }

  private insertProject(project: Project): void {
    this.db.run(
      'INSERT OR REPLACE INTO projects (id, name, data) VALUES (?, ?, ?)',
      [project.id, project.name, JSON.stringify(project)],
    );
  }

  private insertRepo(repo: Repo): void {
    this.db.run(
      'INSERT OR REPLACE INTO repos (id, project, name, data) VALUES (?, ?, ?, ?)',
      [repo.id, repo.project, repo.name, JSON.stringify(repo)],
    );
  }
}

/**
 * Check if the SQLite DB is stale relative to the JSONL source files.
 *
 * Returns true if any JSONL file is newer than the DB, or if the DB
 * doesn't exist yet.
 */
export async function isDbStale(dbPath: string, jsonlPaths: string[]): Promise<boolean> {
  let dbMtime: Date;
  try {
    const dbStat = await stat(dbPath);
    dbMtime = dbStat.mtime;
  } catch {
    return true; // DB doesn't exist
  }

  for (const path of jsonlPaths) {
    try {
      const fileStat = await stat(path);
      if (fileStat.mtime > dbMtime) {
        return true;
      }
    } catch {
      // JSONL file doesn't exist — not stale for this file
    }
  }

  return false;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
