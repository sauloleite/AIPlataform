import { GuardrailBlockedError, PromptInjectionSuspectedError } from '../../domain/errors/index.js';
import type { GuardrailVerdict } from '../ports.js';

/**
 * Pipeline de guardrails como Chain of Responsibility (doc 03, secao 4).
 *
 * Cada etapa e testavel isoladamente e a ordem e configuravel. A etapa recebe o
 * texto e devolve o texto (possivelmente alterado) ou interrompe lancando.
 */
export interface GuardrailStage {
  readonly name: string;
  apply(input: GuardrailContext): Promise<GuardrailContext> | GuardrailContext;
}

export interface GuardrailContext {
  text: string;
  projectId: string;
  verdict?: GuardrailVerdict;
  /** Etapas que efetivamente alteraram ou marcaram o conteudo. */
  applied: string[];
  redactedCount: number;
}

export class GuardrailPipeline {
  constructor(private readonly stages: GuardrailStage[]) {}

  async run(
    text: string,
    projectId: string,
    verdict?: GuardrailVerdict,
  ): Promise<GuardrailContext> {
    let context: GuardrailContext = {
      text,
      projectId,
      ...(verdict !== undefined && { verdict }),
      applied: [],
      redactedCount: verdict?.redactedCount ?? 0,
    };
    for (const stage of this.stages) {
      context = await stage.apply(context);
    }
    return context;
  }
}

/** Bloqueia quando o servico de guardrails decide bloquear. */
export class BlockOnDecisionStage implements GuardrailStage {
  readonly name = 'block_on_decision';

  apply(context: GuardrailContext): GuardrailContext {
    if (context.verdict?.decision === 'block') {
      throw new GuardrailBlockedError(this.name, 'Conteudo bloqueado pela politica de seguranca');
    }
    return { ...context, applied: [...context.applied, this.name] };
  }
}

/** OWASP LLM01: recusa conteudo com indicios fortes de injecao de prompt. */
export class RejectInjectionStage implements GuardrailStage {
  constructor(private readonly threshold = 0.8) {}

  readonly name = 'reject_injection';

  apply(context: GuardrailContext): GuardrailContext {
    const verdict = context.verdict;
    if (verdict === undefined) return context;
    if (verdict.injectionSuspected && verdict.injectionScore >= this.threshold) {
      throw new PromptInjectionSuspectedError(verdict.injectionSignals, verdict.injectionScore);
    }
    return { ...context, applied: [...context.applied, this.name] };
  }
}
