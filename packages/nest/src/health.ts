import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './auth.guard.js';

export type DependencyStatus = 'ok' | 'degraded' | 'down';

export interface CheckResult {
  status: DependencyStatus;
  detail?: string;
}

export interface DependencyCheck {
  name: string;
  /** `critical: false` degrades the service instead of failing readiness. */
  critical: boolean;
  check(): Promise<CheckResult>;
}

export const HEALTH_CHECKS = Symbol('HealthChecks');

/**
 * Liveness and readiness are separate on purpose.
 *
 * Liveness answers while the process is alive: if it failed because a dependency
 * was down, the orchestrator would restart the pod for no reason. Readiness
 * reflects the ability to serve and pulls the replica out of the balancer.
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
    // The return annotation ties both branches to the SAME type. Without it the
    // catch branch infers `status: string` and the union widens the result.
    interface Outcome {
      dependency: DependencyCheck;
      result: CheckResult;
    }

    const results = await Promise.all(
      this.checks.map(async (dependency): Promise<Outcome> => {
        try {
          return { dependency, result: await dependency.check() };
        } catch (error) {
          // A check that THROWS is a "down", not an endpoint error: readiness
          // must answer the orchestrator either way.
          return {
            dependency,
            result: {
              status: 'down',
              detail: error instanceof Error ? error.message : 'check failed',
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
