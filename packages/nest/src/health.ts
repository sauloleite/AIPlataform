import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './auth.guard.js';

export type DependencyStatus = 'ok' | 'degraded' | 'down';

export interface CheckResult {
  status: DependencyStatus;
  detail?: string;
}

export interface DependencyCheck {
  name: string;
  /** `critical: false` degrada o servico em vez de derrubar a readiness. */
  critical: boolean;
  check(): Promise<CheckResult>;
}

export const HEALTH_CHECKS = Symbol('HealthChecks');

/**
 * Liveness e readiness separados de proposito.
 *
 * Liveness responde enquanto o processo esta vivo: se falhasse por dependencia
 * fora, o orquestrador reiniciaria o pod sem motivo. Readiness reflete a
 * capacidade de atender e tira a replica do balanceador.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(HEALTH_CHECKS) private readonly checks: DependencyCheck[]) {}

  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(): Promise<{
    status: 'ok' | 'degraded';
    dependencies: Record<string, CheckResult>;
  }> {
    // A anotacao de retorno amarra os dois ramos ao MESMO tipo. Sem ela, o
    // ramo do catch infere `status: string` e a uniao alarga o resultado.
    interface Outcome {
      dependency: DependencyCheck;
      result: CheckResult;
    }

    const results = await Promise.all(
      this.checks.map(async (dependency): Promise<Outcome> => {
        try {
          return { dependency, result: await dependency.check() };
        } catch (error) {
          // Uma verificacao que LANCA e um "down", nao um erro do endpoint: a
          // readiness precisa responder ao orquestrador de qualquer forma.
          return {
            dependency,
            result: {
              status: 'down',
              detail: error instanceof Error ? error.message : 'falha na verificacao',
            },
          };
        }
      }),
    );

    const dependencies = Object.fromEntries(
      results.map(({ dependency, result }) => [dependency.name, result]),
    );
    const criticalDown = results.some(
      ({ dependency, result }) => dependency.critical && result.status === 'down',
    );
    const anyDegraded = results.some(({ result }) => result.status !== 'ok');

    if (criticalDown) {
      throw new ServiceUnavailableException({ status: 'down', dependencies });
    }
    return { status: anyDegraded ? 'degraded' : 'ok', dependencies };
  }
}
