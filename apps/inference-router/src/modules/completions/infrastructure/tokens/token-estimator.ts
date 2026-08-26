import { Injectable } from '@nestjs/common';
import { encode } from 'gpt-tokenizer';
import type { ChatMessageInput, TokenEstimator } from '../../application/ports.js';

/**
 * Local token counting, to reserve budget BEFORE calling the model.
 *
 * It uses the GPT tokeniser as an approximation for every provider. That is not
 * exact for Gemini or Llama, and it does not need to be: the estimate exists to
 * reserve, and the commit uses the real usage the provider reports. A 15% margin
 * covers the difference between tokenisers without underestimating spend.
 */
@Injectable()
export class GptTokenEstimator implements TokenEstimator {
  private static readonly SAFETY_MARGIN = 1.15;
  /** Per-message overhead in the chat format (role, separators). */
  private static readonly PER_MESSAGE_OVERHEAD = 4;

  countText(text: string): number {
    if (text === '') return 0;
    try {
      return Math.ceil(encode(text).length * GptTokenEstimator.SAFETY_MARGIN);
    } catch {
      // A character outside the vocabulary must not break the budget reservation.
      return Math.ceil((text.length / 4) * GptTokenEstimator.SAFETY_MARGIN);
    }
  }

  countMessages(messages: ChatMessageInput[]): number {
    return messages.reduce(
      (total, message) =>
        total + this.countText(message.content ?? '') + GptTokenEstimator.PER_MESSAGE_OVERHEAD,
      0,
    );
  }
}
