import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '@aia/auth';

/**
 * Contexto da requisicao em curso.
 *
 * Fica em AsyncLocalStorage para que camadas profundas (repositorio, publisher de
 * evento) possam carimbar `project_id` e `principal_id` sem que todo caso de uso
 * precise repassar isso por parametro.
 */
export interface RequestContext {
  requestId: string;
  projectId?: string;
  principal?: Principal;
  traceparent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** `project_id` da requisicao. Lanca em codigo que exige tenant e nao o tem. */
export function currentProjectId(): string | undefined {
  return storage.getStore()?.projectId;
}
