# ADR-024: the platform ships built-in tools, available in every project

- **Status**: accepted
- **Date**: 2026-09-15

## Context

Until now a tool existed only once somebody created it. A project that wanted
its agent to search the web had to find an MCP server or an HTTP endpoint that
does it, create a connection for its key, publish a tool asset in the registry,
bind that asset to the project, and then attach it to the agent. The console
offered none of those steps, so in practice an agent built there had no tools at
all. Saving an agent from the console even sent `tools: []`, which detached
whatever had been attached through the API.

The platform already had the beginning of an answer: the `builtin` tool type,
and a `file_search` executor inside `aia-mcp-gateway`. But `file_search` still
had to be published as an asset and bound per project like any external tool,
and `web_search` and `code_interpreter` were reserved in the contract with
nothing behind them.

Two rules from other decisions shape what a default tool may be:

- **ADR-010.** Classified data may only reach a compatible zone. Web search
  sends the query to a third party; reading a web page sends the URL, and a URL
  can carry anything the model decides to put in it.
- **Reference doc 02 §3.** A tool published in the registry does nothing until a
  project allows it. That rule exists because a registry tool is somebody's
  endpoint, with its own risks.

## Decision

**`aia-mcp-gateway` defines a small set of built-in tools in code, and every
project may use them without creating or binding anything.**

- The set is `web_search`, `web_fetch`, `current_time`, `calculator` and
  `file_search`. Their ids are `builtin.<builtin_id>`. A registry asset id is a
  UUID, which has no dot, so no asset can ever take one.
- A built-in's definition lives next to its executor, not in the registry: the
  argument schema a model is shown IS what the executor parses. A registry copy
  would give one thing two sources of truth, and a project could edit it into
  something the executor does not accept.
- **Allowed by default, governed like everything else.** A built-in needs no
  binding. A binding with `enabled: false` switches it off in that project, and
  a binding may still lower its rate or demand approval. Deleting the binding
  puts the default back. Every call is rate limited and audited with the caller,
  exactly like a registry tool.
- **Each built-in declares where its arguments go.** `web_search` and
  `web_fetch` are `global`, and the other three are `local`. For a `global`
  built-in the gateway reads the project's classification from governance, as
  the caller (ADR-017), and applies `dataZoneIsCompatible`: a `confidential` or
  `restricted` project is never offered one, and a call made anyway is refused.
  If the classification cannot be read, the tool is refused. Only the tools that
  needed governance are lost; the other built-ins and every registry tool keep
  working.
- **A built-in the platform cannot run is not offered.** Each executor reports
  why it is unavailable (`WEB_SEARCH_PROVIDER` unset, a Tavily key nobody
  mounted, `KNOWLEDGE_URL` empty, `WEB_FETCH_ENABLED=false`). `/v1/tools`, which
  models read, leaves such a tool out. `/v1/tools/builtins`, which people read,
  lists it with the reason. A missing backend disables that one tool, the same
  way a missing provider key disables one provider.
- **Web search has two backends.** SearXNG, open source and self-hosted, is in
  the compose file, so a fresh environment searches with no account and no key
  (ADR-012). Tavily is a hosted API for operators who would rather pay than run
  a metasearch engine. Its key is a secret reference, resolved per call (ADR-015).
- **`web_fetch` reads the public internet and nothing else.** The gateway runs
  inside the platform's network, so an unguarded fetch is server-side request
  forgery. URLs are refused before any lookup when they are not http(s), carry
  credentials, use a single-label or local name, or give a non-public IP
  literal. A hostname is resolved inside the lookup the socket connects with,
  and the call is refused if ANY resolved address is private, loopback,
  link-local or reserved. That closes DNS rebinding: the address judged is the
  address used. Every redirect is judged again. The body is capped after
  decompression, and the text handed to the model is cut at 20,000 characters.
  It is also `medium` risk rather than `low`, because the URL itself is a channel
  out.
- **The calculator parses and never evaluates.** A recursive-descent parser over
  a closed grammar, with lookups that cannot reach `Object.prototype`.
- **A registry tool keeps its slug.** If a project already has a bound tool
  called `web-search`, that tool is what models see, and the built-in steps
  aside. Agents attached to the project's own tool were built against it.
- The registry accepts `builtin.<id>` in an agent's `tools` without looking for
  an asset, and refuses an id in that namespace that names no built-in, so a
  typo fails at publish. It mirrors the list from the contract rather than
  asking the gateway: the gateway already calls the registry, and a cycle would
  make each one's outage the other's.
- `code_interpreter` stays reserved and unimplemented. It needs a sandbox, and
  shipping one is its own decision.

## Alternatives considered

| Alternative                                                             | Why not                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seed registry assets and bindings into every project when it is created | Every project gets editable copies that drift from the executor. Existing projects need a backfill, and a new built-in needs another one. It also turns a platform capability into per-project data somebody can delete.          |
| Publish the built-ins once as platform-wide registry assets             | The registry is per project by design. A "global" asset would be a new tenancy concept in the service that least needs one, and it would still leave the schema in two places.                                                    |
| Keep built-ins bind-first, and add a one-click "allow" in the console   | It is still a step between a new project and a working agent, repeated per project. The default is safe to be "on" because data zones, rate limits and audit apply without a binding, and the agent still has to attach the tool. |
| Treat web search as `high` risk so every call needs approval            | Approval is for actions with side effects. A person approving every search would approve all of them, which trains exactly the reflex approval exists to break. The classification rule is the real control.                      |
| Let web tools run in every project, and document the risk               | A confidential project's data would leave the platform through a tool nobody configured. ADR-010 already says no, and it applies here without a new rule.                                                                         |
| `fetch` with a pre-flight DNS check for `web_fetch`                     | `fetch` resolves the name again when it connects. A name that answers public for the check and `169.254.169.254` for the connection walks through.                                                                                |

## Consequences

- `contracts/openapi/mcp-gateway.v1.yaml`: `EffectiveTool` gains `source`
  (`registry` | `platform`), `builtin_id` gains three ids, and
  `GET /v1/tools/builtins` is new. `registry.v1.yaml` documents
  `builtin.<id>` as a valid `ToolRef.asset_id`.
- `ToolExecutor.supports` takes the whole definition instead of a type, and every
  executor now answers `unavailableReason()`.
- The gateway gains `GOVERNANCE_URL`, `WEB_SEARCH_PROVIDER`,
  `WEB_SEARCH_SEARXNG_URL`, `WEB_SEARCH_TAVILY_SECRET_REF` and
  `WEB_FETCH_ENABLED`. Choosing SearXNG without its URL stops the service at
  boot. The compose file gains a `searxng` service. The CI overlay switches web
  search off, because its results change by the hour.
- The console lists built-ins in their own section, with status, data zone and a
  switch for project owners. The agent editor gains a tool picker. Saving an
  agent now carries back its tools, keeping their version pins, and its
  knowledge stores.
- What a page or a search result says reaches the model as a tool result.
  Nothing here makes that text trustworthy. Treating tool output as untrusted
  input (OWASP LLM01) is the agent loop's job, and that gap existed before this
  decision for every tool that returns third-party text.
- Adding a built-in means an entry in the catalogue, an executor, the id in both
  contracts, and the id in the registry's mirror. Forgetting the last one makes
  publishing an agent that uses it fail loudly, never silently.

## Review

Reassess when a built-in with side effects is proposed. The default-on argument
here rests on every built-in being read-only. Reassess also when
`code_interpreter` is taken up, or if an operator needs data zones finer than
`local` and `global` for a search backend hosted in a specific region.
