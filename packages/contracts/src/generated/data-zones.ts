/**
 * AUTOMATICALLY GENERATED. Do not edit.
 * Source: contracts/openapi/. Regenerate with `make contracts`.
 */

export const DATA_ZONES = ["local","br","us","eu","global"] as const;
export type DataZone = (typeof DATA_ZONES)[number];

export const CLASSIFICATIONS = ["public","internal","confidential","restricted"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** ADR-010: the most a classification may reach. A policy narrows, never widens. */
export const MAX_ZONES_BY_CLASSIFICATION: Readonly<Record<Classification, readonly DataZone[]>> =
  {
    "public": [
      "local",
      "br",
      "us",
      "eu",
      "global"
    ],
    "internal": [
      "local",
      "br",
      "us",
      "eu",
      "global"
    ],
    "confidential": [
      "local",
      "br"
    ],
    "restricted": [
      "local"
    ]
  } as const;
