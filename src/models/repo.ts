/**
 * Core domain types for tracked repositories.
 */

import { z } from 'zod';
import { ID_PATTERN } from './project.js';

/** Repository type — GitHub-tracked or manually added. */
export const RepoType = {
  GitHub: 'github',
  Manual: 'manual',
} as const;

/** A tracked repository belonging to a project. */
export const RepoSchema = z.object({
  id: z.string().regex(ID_PATTERN, 'id must be lowercase alphanumeric, hyphens, underscores'),
  project: z.string().min(1, 'project is required'),
  type: z.enum(['github', 'manual']),
  name: z.string().min(1, 'name is required'),
  github_url: z.string().optional(),
  description: z.string().optional(),
  topics: z.array(z.string()).optional(),
  language: z.string().optional(),
  created_at: z.string().optional(), // RFC3339
  updated_at: z.string().optional(), // RFC3339
});
export type Repo = z.infer<typeof RepoSchema>;
