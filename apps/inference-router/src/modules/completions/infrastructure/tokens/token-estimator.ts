import { Injectable } from '@nestjs/common';
import { encode } from 'gpt-tokenizer';
import type { ChatMessageInput, TokenEstimator } from '../../application/ports.js';

/**
 * Contagem local de tokens, para reservar orcamento ANTES de chamar o modelo.
 *
 * Usa o tokenizador do GPT como aproximacao para todos os provedores. Nao e
 * exato para Gemini nem para Llama, e nao precisa ser: a estimativa serve para
 * reservar, e o commit usa o consumo real informado pelo provedor. Uma margem de
 * 15% cobre a diferenca entre tokenizadores sem subestimar o gasto.
 */
@Injectable()
export class GptTokenEstimator implements TokenEstimator {
  private static readonly SAFETY_MARGIN = 1.15;
  /** Sobrecarga por mensagem no formato de chat (role, separadores). */
  private static readonly PER_MESSAGE_OVERHEAD = 4;

  countText(text: string): number {
    if (text === '') return 0;
    try {
      return Math.ceil(encode(text).length * GptTokenEstimator.SAFETY_MARGIN);
    } catch {
      // Caractere fora do vocabulario nao pode quebrar a reserva de orcamento.
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
