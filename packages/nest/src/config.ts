import type { z } from 'zod';

/**
 * Valida a configuracao na inicializacao (doc 03, secao 3.2).
 *
 * A aplicacao NAO sobe com configuracao invalida: falhar no boot e barato,
 * falhar na primeira requisicao de producao nao e.
 *
 * O generico e sobre o SCHEMA, e nao sobre o tipo de saida, porque schemas com
 * `default()` e `transform()` tem entrada e saida diferentes — amarrar os dois
 * recusaria justamente os schemas de configuracao reais.
 */
export function validateConfig<S extends z.ZodTypeAny>(
  schema: S,
  source: NodeJS.ProcessEnv,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data as z.infer<S>;

  const problems = result.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  throw new Error(`Configuracao invalida. Corrija o ambiente:\n${problems}`);
}
