import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { principalOf, projectIdOf, type AuthenticatedRequest } from '@aia/nest';
import { POLICY, authorize } from '@aia/auth';
import { ValidationError, fromUnknown, isDomainError } from '@aia/errors';
import { annotateActiveSpan, currentTraceId } from '@aia/telemetry';
import { CreateChatCompletion } from '../../application/use-cases/create-chat-completion.js';
import { CreateEmbeddings } from '../../application/use-cases/create-embeddings.js';
import { ListModels } from '../../application/use-cases/list-models.js';
import { chatCompletionSchema, embeddingsSchema } from './dto.schema.js';
import { SseWriter } from './sse.js';
import { toChatCompletionResponse, toEmbeddingsResponse } from '../mappers/openai.mapper.js';

/**
 * API canonica de inferencia, compativel com OpenAI.
 *
 * O controller apenas adapta entrada e saida: nao ha regra de negocio aqui.
 * A unica logica propria e o protocolo SSE, que e detalhe de transporte.
 */
@Controller('v1')
export class CompletionsController {
  constructor(
    private readonly createChatCompletion: CreateChatCompletion,
    private readonly createEmbeddings: CreateEmbeddings,
    private readonly listModels: ListModels,
  ) {}

  @Post('chat/completions')
  async chat(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = chatCompletionSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Requisicao invalida', {
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
    }

    const principal = principalOf(request);
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal, projectId });

    const command = {
      requestId: randomUUID(),
      projectId,
      principalId: principal.id,
      alias: parsed.data.model,
      messages: parsed.data.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name !== undefined && { name: message.name }),
      })),
      stream: parsed.data.stream,
      // `max_completion_tokens` e o nome atual; `max_tokens` continua aceito.
      ...(pickMaxTokens(parsed.data) !== undefined && { maxTokens: pickMaxTokens(parsed.data) }),
      ...(parsed.data.temperature !== undefined && { temperature: parsed.data.temperature }),
      ...(parsed.data.top_p !== undefined && { topP: parsed.data.top_p }),
      ...(parsed.data.stop !== undefined && { stop: parsed.data.stop }),
    };

    annotateActiveSpan({
      projectId,
      principalId: principal.id,
      principalType: principal.type,
      alias: command.alias,
    });

    if (!command.stream) {
      const result = await this.createChatCompletion.execute(command);
      response.status(200).json(toChatCompletionResponse(result));
      return;
    }

    await this.streamChat(command, response);
  }

  /**
   * Streaming.
   *
   * Um erro ANTES do primeiro evento vira Problem Details com status HTTP. Depois
   * do primeiro evento os headers ja foram enviados, entao o erro so pode chegar
   * como um evento `error` no proprio stream.
   */
  private async streamChat(
    command: Parameters<CreateChatCompletion['stream']>[0],
    response: Response,
  ): Promise<void> {
    let writer: SseWriter | undefined;

    try {
      for await (const event of this.createChatCompletion.stream(command)) {
        writer ??= new SseWriter(response);
        if (writer.isClosed) break;

        if (event.kind === 'delta') {
          writer.send('message.delta', {
            index: 0,
            delta: { role: 'assistant', content: event.content },
          });
          continue;
        }
        if (event.kind === 'finished') {
          writer.send('run.finished', toChatCompletionResponse(event.result));
          continue;
        }
        writer.send('error', { code: event.code, message: event.message });
      }
      writer?.close();
    } catch (error) {
      if (writer === undefined) {
        // Nada foi enviado ainda: da para responder com o status correto.
        const problem = fromUnknown(error, {
          instance: '/v1/chat/completions',
          ...(currentTraceId() !== undefined && { traceId: currentTraceId() }),
        });
        response.status(problem.status).type('application/problem+json').send(problem);
        return;
      }

      writer.send('error', {
        code: isDomainError(error) ? error.code : 'internal_error',
        message: isDomainError(error) ? error.message : 'Erro interno',
      });
      writer.close();
    }
  }

  @Post('embeddings')
  async embeddings(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = embeddingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Requisicao invalida', {
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
    }

    const principal = principalOf(request);
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal, projectId });

    const result = await this.createEmbeddings.execute({
      requestId: randomUUID(),
      projectId,
      principalId: principal.id,
      alias: parsed.data.model,
      input: typeof parsed.data.input === 'string' ? [parsed.data.input] : parsed.data.input,
    });

    return toEmbeddingsResponse(result);
  }

  @Get('models')
  async models(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });

    return { object: 'list', data: await this.listModels.execute(projectId) };
  }
}

function pickMaxTokens(body: {
  max_tokens?: number;
  max_completion_tokens?: number;
}): number | undefined {
  return body.max_completion_tokens ?? body.max_tokens;
}
