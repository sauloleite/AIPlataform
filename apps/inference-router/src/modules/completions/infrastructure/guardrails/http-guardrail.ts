import { Injectable, Logger } from '@nestjs/common';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';
import type { Guardrail, GuardrailVerdict } from '../../application/ports.js';

interface RedactResponse {
  text: string;
  findings?: { entity_type: string; start: number; end: number; score: number }[];
  redacted_count?: number;
  injection?: { suspected?: boolean; score?: number; signals?: { rule: string }[] };
  decision?: 'allow' | 'redact' | 'block';
}

export interface HttpGuardrailOptions {
  guardrailsUrl: string;
  serviceToken: () => Promise<string>;
  enabled: boolean;
}

/**
 * Cliente do aia-guardrails.
 *
 * Politica de falha: se o servico nao responde, o conteudo SEGUE sem redacao e o
 * fato e registrado. E uma escolha consciente — bloquear toda a inferencia por
 * causa do guardrail transformaria uma degradacao em indisponibilidade. O que a
 * plataforma garante nesse estado e nao PERSISTIR conteudo nao redigido: o caso
 * de uso so grava texto quando o veredito existe.
 */
@Injectable()
export class HttpGuardrail implements Guardrail {
  private readonly logger = new Logger(HttpGuardrail.name);
  private readonly executor = new ResilienceExecutor(POLICIES.GUARDRAIL);

  constructor(private readonly options: HttpGuardrailOptions) {}

  get available(): boolean {
    return this.options.enabled;
  }

  async inspect(text: string, projectId: string, signal?: AbortSignal): Promise<GuardrailVerdict> {
    try {
      const token = await this.options.serviceToken();
      const response = await this.executor.execute(
        (innerSignal) =>
          fetch(`${this.options.guardrailsUrl}/v1/guardrails/redact`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              'X-Project-Id': projectId,
            },
            body: JSON.stringify({ text, language: 'pt', check_injection: true }),
            signal: innerSignal,
          }),
        { key: 'guardrails', ...(signal !== undefined && { signal }) },
      );

      if (!response.ok) throw new Error(`guardrails respondeu ${response.status.toString()}`);

      const payload = (await response.json()) as RedactResponse;
      return {
        text: payload.text,
        findings: (payload.findings ?? []).map((finding) => ({
          entityType: finding.entity_type,
          start: finding.start,
          end: finding.end,
          score: finding.score,
        })),
        redactedCount: payload.redacted_count ?? 0,
        injectionSuspected: payload.injection?.suspected ?? false,
        injectionScore: payload.injection?.score ?? 0,
        injectionSignals: (payload.injection?.signals ?? []).map((signal) => signal.rule),
        decision: payload.decision ?? 'allow',
      };
    } catch (error) {
      this.logger.warn(
        `guardrails indisponivel (${error instanceof Error ? error.message : 'desconhecido'}); conteudo segue sem redacao`,
      );
      return {
        text,
        findings: [],
        redactedCount: 0,
        injectionSuspected: false,
        injectionScore: 0,
        injectionSignals: [],
        decision: 'allow',
      };
    }
  }
}

/** Guardrail desligado. Usado quando o servico nao esta implantado. */
export class DisabledGuardrail implements Guardrail {
  readonly available = false;

  async inspect(text: string): Promise<GuardrailVerdict> {
    return {
      text,
      findings: [],
      redactedCount: 0,
      injectionSuspected: false,
      injectionScore: 0,
      injectionSignals: [],
      decision: 'allow',
    };
  }
}
