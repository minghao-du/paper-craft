/**
 * Core domain types for projects.
 */

import { z } from 'zod';

/** Valid project/repo ID: lowercase alphanumeric, hyphens, underscores; starts with alphanumeric. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** A research project that groups related repositories. */
export const ProjectSchema = z.object({
  id: z.string().regex(ID_PATTERN, 'id must be lowercase alphanumeric, hyphens, underscores'),
  name: z.string().min(1, 'name is required'),
  description: z.string().optional(),
  created_at: z.string().optional(), // RFC3339
  updated_at: z.string().optional(), // RFC3339
});
export type Project = z.infer<typeof ProjectSchema>;
