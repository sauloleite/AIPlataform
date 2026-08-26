import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HealthController, type DependencyCheck } from './health.js';

const ok = (name: string, critical = true): DependencyCheck => ({
  name,
  critical,
  check: () => Promise.resolve({ status: 'ok' as const }),
});

const down = (name: string, critical: boolean): DependencyCheck => ({
  name,
  critical,
  check: () => Promise.resolve({ status: 'down' as const, detail: 'fora' }),
});

const throws = (name: string, critical: boolean): DependencyCheck => ({
  name,
  critical,
  check: () => Promise.reject(new Error('connection refused')),
});

describe('HealthController', () => {
  it('liveness does not consult dependencies', () => {
    // Restarting the pod because the database blinked would turn degradation
    // into an outage. Liveness answers while the process is alive.
    expect(new HealthController([down('mongodb', true)]).live()).toEqual({ status: 'ok' });
  });

  it('readiness is ok when every dependency is ok', async () => {
    const result = await new HealthController([ok('mongodb'), ok('redis', false)]).ready();

    expect(result.status).toBe('ok');
    expect(result.dependencies).toEqual({ mongodb: { status: 'ok' }, redis: { status: 'ok' } });
  });

  it('a NON-critical dependency being down degrades but keeps the replica serving', async () => {
    const result = await new HealthController([ok('mongodb'), down('redis', false)]).ready();

    expect(result.status).toBe('degraded');
    expect(result.dependencies['redis']).toMatchObject({ status: 'down' });
  });

  it('a critical dependency being down pulls the replica from the balancer', async () => {
    const controller = new HealthController([down('mongodb', true)]);
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('a check that throws counts as down, not as an endpoint error', async () => {
    const result = await new HealthController([ok('mongodb'), throws('redis', false)]).ready();

    expect(result.status).toBe('degraded');
    expect(result.dependencies['redis']).toMatchObject({
      status: 'down',
      detail: 'connection refused',
    });
  });

  it('with no declared dependency, readiness answers ok', async () => {
    await expect(new HealthController([]).ready()).resolves.toEqual({
      status: 'ok',
      dependencies: {},
    });
  });
});
