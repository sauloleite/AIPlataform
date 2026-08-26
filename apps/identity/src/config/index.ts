import { z } from 'zod';
import { validateConfig } from '@aia/nest';

/**
 * Configuracao validada na inicializacao. 12-factor: tudo vem do ambiente.
 *
 * Em producao, chave de assinatura ausente derruba o boot: um par efemero faria
 * todo token existente virar invalido no proximo restart.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    MONGO_URI: z.string().min(1),
    MONGO_DATABASE: z.string().default('aia_identity'),
    REDIS_URL: z.string().min(1),

    IDENTITY_ISSUER: z.string().url(),
    IDENTITY_AUDIENCE: z.string().default('aia-platform'),
    IDENTITY_ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(3600),
    /** Pepper do HMAC usado no hash de PAT. */
    IDENTITY_TOKEN_PEPPER: z.string().min(16).default('dev-pepper-troque-em-producao'),
    /** Chave privada PKCS#8 em PEM (com quebras de linha ou \n literais). */
    IDENTITY_SIGNING_PRIVATE_KEY: z.string().optional(),
    IDENTITY_SIGNING_PUBLIC_KEY: z.string().optional(),
    IDENTITY_SIGNING_KID: z.string().default('aia-1'),

    IDENTITY_BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
    IDENTITY_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
    /**
     * Clientes de servico registrados na inicializacao, em JSON:
     *   [{"clientId":"aia-inference-router","secret":"...","scopes":["projects:read"]}]
     *
     * Sem identidade gerenciada de nuvem, e assim que um servico prova quem e
     * para outro (doc 02, secao 6).
     */
    IDENTITY_BOOTSTRAP_SERVICE_CLIENTS: z.string().default('[]'),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV === 'production' && config.IDENTITY_SIGNING_PRIVATE_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IDENTITY_SIGNING_PRIVATE_KEY'],
        message:
          'obrigatoria em producao: sem chave persistida, reiniciar o servico invalida todos os tokens',
      });
    }
    if (
      config.NODE_ENV === 'production' &&
      config.IDENTITY_TOKEN_PEPPER === 'dev-pepper-troque-em-producao'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IDENTITY_TOKEN_PEPPER'],
        message: 'o pepper padrao nao pode ir para producao',
      });
    }
  });

export type IdentityConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const config = validateConfig(schema, source);
  return {
    ...config,
    // Chave em variavel de ambiente costuma vir com \n literal.
    ...(config.IDENTITY_SIGNING_PRIVATE_KEY !== undefined && {
      IDENTITY_SIGNING_PRIVATE_KEY: config.IDENTITY_SIGNING_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
    ...(config.IDENTITY_SIGNING_PUBLIC_KEY !== undefined && {
      IDENTITY_SIGNING_PUBLIC_KEY: config.IDENTITY_SIGNING_PUBLIC_KEY.replace(/\\n/g, '\n'),
    }),
  };
}

export const CONFIG = Symbol('IdentityConfig');
