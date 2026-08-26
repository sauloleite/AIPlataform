import { z } from 'zod';

/**
 * Validacao de borda. Fica na apresentacao porque descreve o CONTRATO HTTP;
 * as regras de negocio moram no dominio.
 */
export const tokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('password'),
    username: z.string().email(),
    password: z.string().min(1),
    scope: z.string().optional(),
  }),
  z.object({
    grant_type: z.literal('client_credentials'),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    scope: z.string().optional(),
  }),
]);

export const introspectRequestSchema = z.object({
  token: z.string().min(1),
});

export const createPatSchema = z.object({
  name: z.string().min(3).max(64),
  project_id: z.string().min(1),
  scopes: z.array(z.string()).min(1),
  expires_in_days: z.number().int().min(1).max(365).default(90),
});

export const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type TokenRequest = z.infer<typeof tokenRequestSchema>;
export type CreatePatBody = z.infer<typeof createPatSchema>;
