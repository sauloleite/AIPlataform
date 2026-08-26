import { GuardrailBlockedError, PromptInjectionSuspectedError } from '../../domain/errors/index.js';
import type { GuardrailVerdict } from '../ports.js';

/**
 * Guardrail pipeline as a Chain of Responsibility (reference doc 03 §4).
 *
 * Each stage is testable in isolation and the order is configurable. A stage
 * receives the text and returns it, possibly altered, or stops by throwing.
 */
export interface GuardrailStage {
  readonly name: string;
  apply(input: GuardrailContext): Promise<GuardrailContext> | GuardrailContext;
}

export interface GuardrailContext {
  text: string;
  projectId: string;
  verdict?: GuardrailVerdict;
  /** Stages that actually altered or flagged the content. */
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

/** Blocks when the guardrails service decides to block. */
export class BlockOnDecisionStage implements GuardrailStage {
  readonly name = 'block_on_decision';

  apply(context: GuardrailContext): GuardrailContext {
    if (context.verdict?.decision === 'block') {
      throw new GuardrailBlockedError(this.name, 'Content blocked by the security policy');
    }
    return { ...context, applied: [...context.applied, this.name] };
  }
}

/** OWASP LLM01: rejects content showing strong signs of prompt injection. */
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
