# ADR-024: the Gateway API replaces the Ingress

- **Status**: accepted
- **Date**: 2026-09-08

## Context

The Helm chart routed with `networking.k8s.io/v1 Ingress` and a
`nginx.ingress.kubernetes.io/*` annotation for each behaviour the Ingress
specification cannot express — SSE buffering off, and a read timeout long enough
for a model that thinks for minutes.

Three things forced a decision rather than a preference.

**The API is frozen.** Kubernetes closed the Ingress API to new features and
points at the Gateway API in its place. Annotations are not a workaround for
that; they are the symptom. Every one of them is a contract with a specific
controller, which is the opposite of what this chart is for (ADR-012).

**The controller it named was retired.** `ingress-nginx` reached end of life in
March 2026 with no further security patches, and `ingress.className: nginx` was
the chart's default. A default that installs an unmaintained component is worse
than no default.

**The routing table was written twice and drifted.** The chart routed
`/v1/agents` to `aia-agent-runtime` and never routed `/v1/runs`, so reading a
run and approving a tool call both fell through to the `/` catch-all and reached
the web console. `/v1/connections` and `/v1/evaluations` were missing the same
way. Nothing detected it, because an Ingress that routes the wrong backend is
still a valid Ingress.

Canary by weight is also a requirement rather than a nicety: reference doc 02
§11 promotes a model deployment as a release, and `docs/runbooks/model-deprecation.md`
tells the operator to run one. An Ingress cannot split traffic without, again,
controller-specific annotations.

## Decision

**The chart renders a `Gateway` and an `HTTPRoute` by default**, and the routing
table is defined once, in the `aia.routeTable` template, from which both the
Gateway API and the Ingress manifests are generated.

`networking.mode: ingress` keeps rendering the Ingress for a cluster with no
Gateway controller installed. It reads the same table, so the two cannot
disagree again.

Two consequences fall out of the API rather than out of preference. An HTTPRoute
matches by specificity regardless of rule order, so `/` cannot shadow `/v1/chat`
by being written first — the ordering comment the Ingress needed is now enforced
by the specification. And `timeouts.request` is a field, so the long-response
budget stops being an nginx annotation.

## Alternatives considered

| Alternative                                | Why not                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the Ingress and change the controller | Moves the annotations to a different vendor's dialect. The lock-in ADR-012 forbids is the annotation, not the controller.                       |
| Keep the Ingress and add the missing paths | Fixes the three routes and leaves the cause: two hand-written copies of one table, on a frozen API, defaulting to a retired controller.         |
| Gateway API only, dropping the Ingress     | Gateway controllers are not yet installed everywhere, and a chart that will not deploy is not portable. The fallback costs one template branch. |
| Traefik in the cluster, as under compose   | Would make the compose file and the chart agree, and would put a specific proxy into a chart whose point is that the edge is replaceable.       |

## Consequences

- The cluster needs a Gateway controller and the Gateway API CRDs. Where there
  is none, `networking.mode=ingress` is one value away.
- Routing is now data. Adding a service means one entry in `aia.routeTable`, and
  both manifests follow.
- Canary by weight becomes available to the model-promotion work without another
  networking change.
- CI renders both modes and asserts that every service running under compose
  also renders in the chart, so the class of drift that produced this ADR fails
  the build rather than reaching a cluster.
- The NetworkPolicy no longer matches the edge by `app.kubernetes.io/name:
ingress-nginx`. It matches the namespace, because with a Gateway controller
  that label names something else, and a policy that silently denies everything
  is worse than one that is explicit about what it trusts.

## Review

Revisit if the Gateway API's own conformance profiles make the Ingress fallback
pointless, or if a cluster this platform must run on turns out to have no
Gateway controller available at all.
