import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { BudgetReservation } from '../../domain/entities/budget-reservation.js';
import { BudgetExhaustedError } from '../../domain/errors/index.js';
import { Cost } from '../../domain/value-objects/index.js';
import type { BudgetLedger, ReserveInput } from '../../application/ports.js';

/**
 * Contabilidade de orcamento em Redis, com atomicidade garantida por Lua.
 *
 * Por que Lua e nao GET + SET: entre ler o saldo e grava-lo, outra replica pode
 * ler o MESMO saldo. Com N chamadas simultaneas, todas passariam pelo limite.
 * O script roda inteiro dentro do Redis, sem intercalacao possivel.
 *
 * O estado sao dois contadores por projeto e periodo:
 *   spent    - ja confirmado
 *   reserved - preso por chamadas em voo
 * A autorizacao olha a SOMA dos dois; o commit move de `reserved` para `spent`.
 */
@Injectable()
export class RedisBudgetLedger implements BudgetLedger {
  private readonly logger = new Logger(RedisBudgetLedger.name);
  private healthy = true;

  /**
   * Reserva: falha se `spent + reserved + estimado` passar do limite.
   * Devolve `{ok, reservedTotal}` para que o chamador saiba o estado resultante.
   */
  private static readonly RESERVE = `
    local spentKey, reservedKey = KEYS[1], KEYS[2]
    local estimated  = tonumber(ARGV[1])
    local limit      = tonumber(ARGV[2])
    local ttl        = tonumber(ARGV[3])
    local blocking   = ARGV[4] == '1'

    local spent    = tonumber(redis.call('GET', spentKey) or '0')
    local reserved = tonumber(redis.call('GET', reservedKey) or '0')

    if blocking and (spent + reserved + estimated) > limit then
      return { 0, spent + reserved }
    end

    redis.call('INCRBY', reservedKey, estimated)
    -- O TTL acompanha o fim do periodo: a virada zera os contadores sozinha.
    redis.call('EXPIRE', reservedKey, ttl)
    redis.call('EXPIRE', spentKey, ttl)
    return { 1, spent + reserved + estimated }
  `;

  /**
   * Commit: solta a reserva e soma o custo real ao gasto.
   * `max(0, ...)` protege contra uma reserva ja expirada por TTL.
   */
  private static readonly COMMIT = `
    local spentKey, reservedKey = KEYS[1], KEYS[2]
    local estimated = tonumber(ARGV[1])
    local actual    = tonumber(ARGV[2])
    local ttl       = tonumber(ARGV[3])

    local reserved = tonumber(redis.call('GET', reservedKey) or '0')
    local newReserved = reserved - estimated
    if newReserved < 0 then newReserved = 0 end

    redis.call('SET', reservedKey, newReserved, 'EX', ttl)
    local spent = redis.call('INCRBY', spentKey, actual)
    redis.call('EXPIRE', spentKey, ttl)
    return { spent, newReserved }
  `;

  /** Release: devolve a estimativa sem tocar no gasto. Compensacao da saga. */
  private static readonly RELEASE = `
    local reservedKey = KEYS[1]
    local estimated = tonumber(ARGV[1])
    local ttl = tonumber(ARGV[2])

    local reserved = tonumber(redis.call('GET', reservedKey) or '0')
    local newReserved = reserved - estimated
    if newReserved < 0 then newReserved = 0 end

    redis.call('SET', reservedKey, newReserved, 'EX', ttl)
    return newReserved
  `;

  /**
   * TTL usado em commit e release. O valor exato importa pouco: a chave ja
   * carrega o periodo, entao expirar cedo demais so custa uma releitura.
   */
  private readonly ttlSeconds = 40 * 24 * 60 * 60;

  constructor(private readonly redis: Redis) {
    redis.on('error', (error: Error) => {
      if (this.healthy) {
        this.logger.warn(`Redis indisponivel: ${error.message}. Entrando em budget_unverified.`);
      }
      this.healthy = false;
    });
    redis.on('ready', () => {
      if (!this.healthy) this.logger.log('Redis de volta. Orcamento verificado novamente.');
      this.healthy = true;
    });
  }

  isAvailable(): boolean {
    return this.healthy && this.redis.status === 'ready';
  }

  /**
   * Chaves dos contadores.
   *
   * A chave do periodo vem de fora e e ESTAVEL (`2026-03`): derivar da hora atual
   * faria a reserva e o commit da mesma chamada caírem em chaves diferentes, e o
   * orcamento nunca acumularia. A virada de periodo troca a chave sozinha, sem
   * migracao nem job de limpeza.
   */
  private keysFor(projectId: string, periodKey: string): [string, string] {
    const prefix = `aia:budget:${projectId}:${periodKey}`;
    return [`${prefix}:spent`, `${prefix}:reserved`];
  }

  async reserve(input: ReserveInput): Promise<BudgetReservation> {
    const keys = this.keysFor(input.projectId, input.periodKey);
    const ttl = Math.max(60, input.periodEndsInSeconds);

    const [ok] = (await this.redis.eval(
      RedisBudgetLedger.RESERVE,
      2,
      keys[0],
      keys[1],
      input.estimated.micros.toString(),
      input.limitMicros.toString(),
      ttl.toString(),
      input.blockAtLimit ? '1' : '0',
    )) as [number, number];

    if (ok !== 1) {
      throw new BudgetExhaustedError(input.projectId, Math.max(1, input.periodEndsInSeconds));
    }

    return BudgetReservation.held({
      id: randomUUID(),
      projectId: input.projectId,
      estimated: input.estimated,
      periodKey: input.periodKey,
    });
  }

  async commit(reservation: BudgetReservation, actual: Cost): Promise<void> {
    if (reservation.isUnverified) {
      reservation.commit(actual);
      return;
    }

    // A propria reserva diz onde e quanto: nada depende de estado deste processo,
    // entao um restart entre reserva e commit nao perde a contabilidade.
    const keys = this.keysFor(reservation.projectId, reservation.periodKey);

    await this.redis.eval(
      RedisBudgetLedger.COMMIT,
      2,
      keys[0],
      keys[1],
      reservation.estimated.micros.toString(),
      actual.micros.toString(),
      this.ttlSeconds.toString(),
    );

    reservation.commit(actual);
  }

  async release(reservation: BudgetReservation): Promise<void> {
    if (reservation.isUnverified || reservation.state === 'committed') return;

    const keys = this.keysFor(reservation.projectId, reservation.periodKey);

    await this.redis.eval(
      RedisBudgetLedger.RELEASE,
      1,
      keys[1],
      reservation.estimated.micros.toString(),
      this.ttlSeconds.toString(),
    );

    reservation.release();
  }

  /** Estado atual, para a reconciliacao diaria e para o painel de FinOps. */
  async snapshot(
    projectId: string,
    periodKey: string,
  ): Promise<{ spentMicros: bigint; reservedMicros: bigint }> {
    const keys = this.keysFor(projectId, periodKey);
    const [spent, reserved] = await this.redis.mget(keys[0], keys[1]);
    return {
      spentMicros: BigInt(spent ?? '0'),
      reservedMicros: BigInt(reserved ?? '0'),
    };
  }
}
