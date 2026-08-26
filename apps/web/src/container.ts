import { cookies } from 'next/headers';

import { loadConfig } from './modules/console/config';
import { HttpPlatformGateway } from './modules/console/infrastructure/http/platform-gateway';
import { CookieSessionStore } from './modules/console/infrastructure/session/cookie-session';
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

export interface Container {
  sessions: SessionStore;
  authorize: AuthorizeRequest;
  signIn: SignIn;
  listProjects: ListProjects;
  inspectProject: InspectProject;
  createProject: CreateProject;
  setBudget: SetBudget;
  sendChatMessage: SendChatMessage;
}

/**
 * Built per request, because the cookie jar is per request.
 *
 * The gateway and the clock are stateless and shared; only the session store
 * closes over the current request's cookies.
 */
export async function getContainer(): Promise<Container> {
  const jar = await cookies();
  const sessions = new CookieSessionStore(jar, config.NODE_ENV === 'production');

  return {
    sessions,
    authorize: new AuthorizeRequest(sessions, clock),
    signIn: new SignIn(platform, sessions, clock),
    listProjects: new ListProjects(platform),
    inspectProject: new InspectProject(platform),
    createProject: new CreateProject(platform),
    setBudget: new SetBudget(platform),
    sendChatMessage: new SendChatMessage(platform),
  };
}
