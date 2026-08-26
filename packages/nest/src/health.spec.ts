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
  check: () => Promise.reject(new Error('conexao recusada')),
});

describe('HealthController', () => {
  it('liveness nao consulta dependencia', () => {
    // Reiniciar o pod porque o banco piscou transformaria degradacao em
    // indisponibilidade. Liveness responde enquanto o processo vive.
    expect(new HealthController([down('mongodb', true)]).live()).toEqual({ status: 'ok' });
  });

  it('readiness fica ok quando todas as dependencias estao ok', async () => {
    const result = await new HealthController([ok('mongodb'), ok('redis', false)]).ready();

    expect(result.status).toBe('ok');
    expect(result.dependencies).toEqual({ mongodb: { status: 'ok' }, redis: { status: 'ok' } });
  });

  it('dependencia NAO critica fora degrada, mas mantem a replica servindo', async () => {
    const result = await new HealthController([ok('mongodb'), down('redis', false)]).ready();

    expect(result.status).toBe('degraded');
    expect(result.dependencies['redis']).toMatchObject({ status: 'down' });
  });

  it('dependencia critica fora tira a replica do balanceador', async () => {
    const controller = new HealthController([down('mongodb', true)]);
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('verificacao que lanca conta como down, e nao como erro do endpoint', async () => {
    const result = await new HealthController([ok('mongodb'), throws('redis', false)]).ready();

    expect(result.status).toBe('degraded');
    expect(result.dependencies['redis']).toMatchObject({
      status: 'down',
      detail: 'conexao recusada',
    });
  });

  it('sem dependencia declarada, readiness responde ok', async () => {
    await expect(new HealthController([]).ready()).resolves.toEqual({
      status: 'ok',
      dependencies: {},
    });
  });
});
