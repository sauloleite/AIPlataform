import { z } from 'zod';
import { CLASSIFICATIONS, DATA_ZONES } from '../../domain/value-objects/data-classification.js';

export const createProjectSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
  name: z.string().min(3).max(120),
  description: z.string().max(1000).optional(),
  data_classification: z.enum(CLASSIFICATIONS),
  legal_basis: z.string().min(3),
  purpose: z.string().min(3),
  cost_center: z.string().optional(),
  owner_principal_id: z.string().optional(),
});

export const setBudgetSchema = z.object({
  limit: z.object({
    currency: z.string().length(3),
    micros: z.number().int().nonnegative(),
  }),
  period: z.enum(['daily', 'monthly']),
  block_at_limit: z.boolean().optional(),
  alert_thresholds: z.array(z.number().positive().max(2)).optional(),
});

export const setPolicySchema = z.object({
  allowed_data_zones: z.array(z.enum(DATA_ZONES)).min(1).optional(),
  model_rules: z
    .array(
      z.object({
        alias: z.string().min(1),
        allowed: z.boolean(),
        max_output_tokens: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  max_concurrent_requests: z.number().int().min(1).optional(),
  content_capture: z.boolean().optional(),
});

export const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
