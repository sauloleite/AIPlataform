/**
 * Application layer ports.
 *
 * Interfaces, never concrete classes: a use case does not know whether the
 * platform is reached over HTTP or faked in a test, and it does not know that a
 * session lives in a cookie. That is what lets every rule below be tested with
 * no network and no Next.js runtime.
 */
import type { Principal, Session } from '../domain/session';

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description?: string;
  dataClassification: string;
  legalBasis?: string;
  purpose?: string;
  createdAt: string;
}

export interface BudgetSnapshot {
  projectId: string;
  limit: { currency: string; micros: string };
  spent: { currency: string; micros: string };
  reserved?: { currency: string; micros: string };
  period: 'daily' | 'monthly';
  periodStart: string;
  periodEnd: string;
  blockAtLimit: boolean;
}

export interface PolicySnapshot {
  projectId: string;
  dataClassification: string;
  allowedDataZones: string[];
  maxConcurrentRequests: number;
  contentCapture: boolean;
  version: number;
}

export interface ModelAliasSummary {
  id: string;
  description?: string;
  capabilities: string[];
  maxOutputTokens?: number;
  dataZones: string[];
}

export interface RoutingReport {
  deploymentId?: string;
  provider?: string;
  providerModel?: string;
  dataZone?: string;
  cost?: { currency: string; micros: string };
  cacheHit?: boolean;
  policyStale?: boolean;
  budgetUnverified?: boolean;
  attempts?: number;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  projectId: string;
  alias: string;
  messages: ChatTurn[];
  maxTokens?: number;
}

/** What the console observes while a completion streams. */
export type ChatStreamEvent =
  | { kind: 'delta'; content: string }
  | { kind: 'finished'; content: string; routing: RoutingReport }
  | { kind: 'error'; code: string; message: string };

/**
 * Everything the console needs from the platform.
 *
 * One port, not one per service: the console is a single consumer and splitting
 * it would only spread the same wiring across more files. The adapter behind it
 * is what knows that identity, governance and the router are separate services.
 */
export interface PlatformGateway {
  signIn(username: string, password: string): Promise<{ accessToken: string; expiresIn: number }>;
  currentPrincipal(accessToken: string): Promise<Principal>;

  listProjects(accessToken: string): Promise<ProjectSummary[]>;
  getProject(accessToken: string, projectId: string): Promise<ProjectSummary>;
  createProject(
    accessToken: string,
    input: {
      slug: string;
      name: string;
      description?: string;
      dataClassification: string;
      legalBasis: string;
      purpose: string;
    },
  ): Promise<ProjectSummary>;

  getBudget(accessToken: string, projectId: string): Promise<BudgetSnapshot>;
  setBudget(
    accessToken: string,
    projectId: string,
    input: { currency: string; micros: string; period: 'daily' | 'monthly'; blockAtLimit: boolean },
  ): Promise<BudgetSnapshot>;

  getPolicy(accessToken: string, projectId: string): Promise<PolicySnapshot>;
  listModels(accessToken: string, projectId: string): Promise<ModelAliasSummary[]>;

  streamChat(accessToken: string, request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

/**
 * Where the access token lives.
 *
 * The implementation writes an httpOnly cookie, which is why this port exists
 * at all: a use case that called `document.cookie` would be a use case that only
 * runs in a browser, and the token must never reach one.
 */
export interface SessionStore {
  read(): Promise<Session | null>;
  readToken(): Promise<string | null>;
  write(session: Session, accessToken: string): Promise<void>;
  clear(): Promise<void>;
}

/** Injected so expiry checks are testable without waiting. */
export interface Clock {
  nowSeconds(): number;
}
