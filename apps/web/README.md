# aia-web

The platform console: projects, budget, policies and a chat playground.

Next.js App Router, in the same monorepo as the services, so it consumes the
same generated contract types the backend does. A contract change breaks the
console's build in the same PR that changes it, rather than at runtime later.

## Why a BFF

The browser never holds a platform token. Signing in stores the access token in
an httpOnly cookie, and every call to the platform is made by this app's own
server, which reads the cookie and attaches the `Authorization` header.

A token in `localStorage` is readable by any injected script, and one XSS then
becomes a stolen platform credential that works from anywhere, for as long as
the token lives. An httpOnly cookie can be sent by the browser but never read by
it, so the same XSS is confined to acting as the user while they are on the page.

## Layout

```
src/
  app/                    Next App Router: pages, Server Actions, one SSE route
  modules/console/
    domain/               pure rules — Money, classification, session, errors
    application/          use cases and ports
    infrastructure/       the HTTP gateway, the cookie session, the SSE parser
  container.ts            the only wiring
```

Imports inside this app carry no `.js` suffix, unlike the rest of the monorepo.
The services compile under `NodeNext`, where the suffix is required; Next resolves
with `Bundler`, where it is not, and its webpack pass does not rewrite `.js` to
`.ts`. Inside the Next app, Next's convention wins.

The same dependency rule as every service: `domain/` knows nothing, application
talks only to ports, and `app/` reaches infrastructure through the container.
`make arch` checks it.

Reads are Server Components calling use cases directly — no HTTP hop to fetch
what the server can already read. Writes are Server Actions. Streaming is the
one thing that needs a route handler, because an action returns once and a chat
answer arrives token by token.

## Running it

```bash
make dev            # the console comes up with the platform, at :3005
pnpm --filter @aia/web dev   # or on its own, against a running platform
```

| Variable               | Default                      |
| ---------------------- | ---------------------------- |
| `IDENTITY_URL`         | http://identity:3001         |
| `GOVERNANCE_URL`       | http://governance:3002       |
| `INFERENCE_ROUTER_URL` | http://inference-router:3000 |
| `PLATFORM_TIMEOUT_MS`  | 30000                        |

None of them is `NEXT_PUBLIC_`: a `NEXT_PUBLIC_` variable is inlined into the
browser bundle, and the browser has no business knowing the platform's internal
addresses. It talks only to this app.
