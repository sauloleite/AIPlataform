import { cookies, headers } from 'next/headers';

import { loadConfig } from './modules/console/config';
import { HttpPlatformGateway } from './modules/console/infrastructure/http/platform-gateway';
import { HttpRegistryGateway } from './modules/registry/infrastructure/http/registry-gateway';
import type { RegistryGateway } from './modules/registry/application/ports';
import type { KnowledgeGateway } from './modules/knowledge/application/ports';
import type { ToolsGateway } from './modules/tools/application/ports';
import { HttpToolsGateway } from './modules/tools/infrastructure/http/tools-gateway';
import type { AgentRuntimeGateway } from './modules/agents/application/ports';
import { HttpAgentRuntimeGateway } from './modules/agents/infrastructure/http/agent-runtime-gateway';
import { RunAgentInPlayground } from './modules/agents/application/use-cases/run-agent';
import type { TraceGateway } from './modules/observability/application/ports';
import { HttpTempoGateway } from './modules/observability/infrastructure/http/tempo-gateway';
import {
  InspectTrace,
  ListTraces,
} from './modules/observability/application/use-cases/inspect-traces';
import type { EvaluationGateway } from './modules/observability/application/evaluation-ports';
import { HttpEvaluationGateway } from './modules/observability/infrastructure/http/evaluation-gateway';
import { ListEvaluations } from './modules/observability/application/use-cases/inspect-evaluations';
import {
  AnnotateTrace,
  ReadAnnotations,
} from './modules/observability/application/use-cases/annotate-trace';
import { InspectCompletion } from './modules/observability/application/use-cases/inspect-completion';
import {
  BindTool,
  ListTools,
  UnbindTool,
} from './modules/tools/application/use-cases/inspect-tools';
import {
  CreateConnection,
  DeleteConnection,
  ListConnections,
} from './modules/tools/application/use-cases/inspect-connections';
import { HttpKnowledgeGateway } from './modules/knowledge/infrastructure/http/knowledge-gateway';
import {
  InspectStore,
  ListCatalogue,
  ListStores,
} from './modules/knowledge/application/use-cases/inspect-store';
import {
  SetStoreVisibility,
  SubscribeToStore,
  UnsubscribeFromStore,
} from './modules/knowledge/application/use-cases/share-store';
import {
  CreateStore,
  DeleteDocument,
  SearchStore,
  UploadDocument,
} from './modules/knowledge/application/use-cases/manage-documents';
import { InspectAgent } from './modules/registry/application/use-cases/inspect-agent';
import { ListAgents } from './modules/registry/application/use-cases/list-agents';
import {
  CreateAgent,
  PublishAgent,
  SaveAgentDraft,
} from './modules/registry/application/use-cases/save-agent';
import {
  CookieSessionStore,
  servedOverHttps,
} from './modules/console/infrastructure/session/cookie-session';
import { AuthorizeRequest } from './modules/console/application/use-cases/authorize-request';
import { CreateProject } from './modules/console/application/use-cases/create-project';
import { InspectProject } from './modules/console/application/use-cases/inspect-project';
import { ListProjects } from './modules/console/application/use-cases/list-projects';
import { SendChatMessage } from './modules/console/application/use-cases/send-chat-message';
import { SetBudget } from './modules/console/application/use-cases/set-budget';
import { SignIn } from './modules/console/application/use-cases/sign-in';
import type { Clock, PlatformGateway, SessionStore } from './modules/console/application/ports';

/**
 * Dependency composition.
 *
 * The only place that knows all three layers at once. A page or a route handler
 * asks for a use case and never names an adapter, which is what keeps the
 * dependency rule true in a framework that would happily let a component call
 * `fetch` directly.
 *
 * SERVER ONLY. `next/headers` throws in a client component, which turns the
 * "don't reach for this from the browser" rule into a build error rather than a
 * convention.
 */
const config = loadConfig();

const clock: Clock = { nowSeconds: () => Math.floor(Date.now() / 1000) };

const platform: PlatformGateway = new HttpPlatformGateway(
  {
    identity: config.IDENTITY_URL,
    governance: config.GOVERNANCE_URL,
    router: config.INFERENCE_ROUTER_URL,
  },
  fetch,
  config.PLATFORM_TIMEOUT_MS,
);

const registry: RegistryGateway = new HttpRegistryGateway(
  config.REGISTRY_URL,
  fetch,
  config.PLATFORM_TIMEOUT_MS,
);

const knowledge: KnowledgeGateway = new HttpKnowledgeGateway(
  config.KNOWLEDGE_URL,
  fetch,
  config.PLATFORM_TIMEOUT_MS,
);

const toolsGateway: ToolsGateway = new HttpToolsGateway(
  config.MCP_GATEWAY_URL,
  fetch,
  config.PLATFORM_TIMEOUT_MS,
);

// No timeout: a run waits for a person to approve, and a clock that gives up
// after thirty seconds would turn every considered decision into a dropped
// connection.
const agentRuntime: AgentRuntimeGateway = new HttpAgentRuntimeGateway(
  config.AGENT_RUNTIME_URL,
  fetch,
);

// An empty URL leaves the gateway unavailable, and the Traces screen says so
// rather than erroring: an observability backend that is down should not take
// the console with it.
const traces: TraceGateway = new HttpTempoGateway(config.TEMPO_URL, fetch);

const evaluations: EvaluationGateway = new HttpEvaluationGateway(
  config.EVALUATION_URL,
  fetch,
  config.PLATFORM_TIMEOUT_MS,
);

export interface Container {
  sessions: SessionStore;
  authorize: AuthorizeRequest;
  signIn: SignIn;
  listProjects: ListProjects;
  inspectProject: InspectProject;
  createProject: CreateProject;
  setBudget: SetBudget;
  sendChatMessage: SendChatMessage;
  listAgents: ListAgents;
  inspectAgent: InspectAgent;
  createAgent: CreateAgent;
  saveAgentDraft: SaveAgentDraft;
  publishAgent: PublishAgent;
  runAgent: RunAgentInPlayground;
  listStores: ListStores;
  inspectStore: InspectStore;
  listCatalogue: ListCatalogue;
  setStoreVisibility: SetStoreVisibility;
  subscribeToStore: SubscribeToStore;
  unsubscribeFromStore: UnsubscribeFromStore;
  createStore: CreateStore;
  uploadDocument: UploadDocument;
  deleteDocument: DeleteDocument;
  searchStore: SearchStore;
  listTools: ListTools;
  bindTool: BindTool;
  unbindTool: UnbindTool;
  listConnections: ListConnections;
  createConnection: CreateConnection;
  deleteConnection: DeleteConnection;
  listTraces: ListTraces;
  inspectTrace: InspectTrace;
  listEvaluations: ListEvaluations;
  readAnnotations: ReadAnnotations;
  annotateTrace: AnnotateTrace;
  inspectCompletion: InspectCompletion;
}

/**
 * Built per request, because the cookie jar is per request.
 *
 * The gateway and the clock are stateless and shared; only the session store
 * closes over the current request's cookies.
 */
export async function getContainer(): Promise<Container> {
  const [jar, headerList] = await Promise.all([cookies(), headers()]);
  const sessions = new CookieSessionStore(jar, servedOverHttps(headerList));

  return {
    sessions,
    authorize: new AuthorizeRequest(sessions, clock),
    signIn: new SignIn(platform, sessions, clock),
    listProjects: new ListProjects(platform),
    inspectProject: new InspectProject(platform),
    createProject: new CreateProject(platform),
    setBudget: new SetBudget(platform),
    sendChatMessage: new SendChatMessage(platform),
    listAgents: new ListAgents(registry),
    inspectAgent: new InspectAgent(registry),
    createAgent: new CreateAgent(registry),
    saveAgentDraft: new SaveAgentDraft(registry),
    publishAgent: new PublishAgent(registry),
    runAgent: new RunAgentInPlayground(agentRuntime),
    listStores: new ListStores(knowledge),
    inspectStore: new InspectStore(knowledge),
    listCatalogue: new ListCatalogue(knowledge),
    setStoreVisibility: new SetStoreVisibility(knowledge),
    subscribeToStore: new SubscribeToStore(knowledge),
    unsubscribeFromStore: new UnsubscribeFromStore(knowledge),
    createStore: new CreateStore(knowledge),
    uploadDocument: new UploadDocument(knowledge),
    deleteDocument: new DeleteDocument(knowledge),
    searchStore: new SearchStore(knowledge),
    listTools: new ListTools(toolsGateway),
    bindTool: new BindTool(toolsGateway),
    unbindTool: new UnbindTool(toolsGateway),
    listConnections: new ListConnections(toolsGateway),
    createConnection: new CreateConnection(toolsGateway),
    deleteConnection: new DeleteConnection(toolsGateway),
    listTraces: new ListTraces(traces),
    inspectTrace: new InspectTrace(traces),
    listEvaluations: new ListEvaluations(evaluations),
    readAnnotations: new ReadAnnotations(evaluations),
    annotateTrace: new AnnotateTrace(evaluations),
    inspectCompletion: new InspectCompletion(platform),
  };
}
