import { z } from 'zod';

/** Edge validation for the OpenAI-compatible contract. */
export const chatCompletionSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.string().nullable(),
        name: z.string().optional(),
        tool_call_id: z.string().optional(),
      }),
    )
    .min(1),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.array(z.string()).max(4).optional(),
  user: z.string().optional(),
});

export const embeddingsSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(2048)]),
  dimensions: z.number().int().positive().optional(),
});

export type ChatCompletionBody = z.infer<typeof chatCompletionSchema>;
export type EmbeddingsBody = z.infer<typeof embeddingsSchema>;
