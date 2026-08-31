import { z } from 'zod';

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
  // Opaque, and deliberately unvalidated beyond being a string: the platform
  // carries it and never reads it.
  provider_state: z.string().optional(),
});

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
        tool_calls: z.array(toolCallSchema).optional(),
      }),
    )
    .min(1),
  tools: z
    .array(
      z.object({
        type: z.literal('function'),
        function: z.object({
          // The name travels to the provider and comes back as an identifier;
          // anything looser would not survive the round trip intact.
          name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'must be 1-64 chars of [a-zA-Z0-9_-]'),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .max(128)
    .optional(),
  tool_choice: z
    .union([
      z.enum(['auto', 'none', 'required']),
      z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }) }),
    ])
    .optional(),
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
