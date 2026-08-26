import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '@aia/auth';

/**
 * Context of the request in flight.
 *
 * Held in AsyncLocalStorage so deeper layers (a repository, an event publisher)
 * can stamp `project_id` and `principal_id` without every use case threading
 * them through as parameters.
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

/** The request's `project_id`. */
export function currentProjectId(): string | undefined {
  return storage.getStore()?.projectId;
}
