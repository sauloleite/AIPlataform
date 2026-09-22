import { Injectable } from '@nestjs/common';

import { InvalidToolArgumentsError } from '../../domain/errors/index.js';
import { ArithmeticError, evaluateArithmetic } from '../../domain/services/arithmetic.js';
import type { ToolDefinition } from '../../domain/value-objects/index.js';
import type { ToolExecutor, ToolInvocation, ToolOutcome } from '../../application/ports.js';

/** The `calculator` built-in. No I/O, so nothing to configure and nothing to wait for. */
@Injectable()
export class CalculatorExecutor implements ToolExecutor {
  supports(tool: ToolDefinition): boolean {
    return tool.toolType === 'builtin' && tool.builtinId === 'calculator';
  }

  async unavailableReason(): Promise<string | null> {
    return null;
  }

  async execute(invocation: ToolInvocation): Promise<ToolOutcome> {
    const expression = invocation.arguments['expression'];
    if (typeof expression !== 'string') {
      throw new InvalidToolArgumentsError(invocation.tool.toolId, 'calculator needs an expression');
    }

    const started = Date.now();
    try {
      const result = evaluateArithmetic(expression);
      return { result: { expression, result }, durationMs: Date.now() - started };
    } catch (error) {
      if (error instanceof ArithmeticError) {
        throw new InvalidToolArgumentsError(invocation.tool.toolId, error.message);
      }
      throw error;
    }
  }
}
