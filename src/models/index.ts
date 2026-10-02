/** Re-export all domain models from a single entry point. */
export { AuthorSchema, PublicationDateSchema, ImportSourceSchema, ReferenceSchema, mergeReferences } from './reference.js';
export type { Author, PublicationDate, ImportSource, Reference } from './reference.js';

export { ProjectSchema, ID_PATTERN } from './project.js';
export type { Project } from './project.js';

export { RepoSchema, RepoType } from './repo.js';
export type { Repo } from './repo.js';
