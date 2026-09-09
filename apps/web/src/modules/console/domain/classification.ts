/**
 * Data classification and the zones each one permits (ADR-010).
 *
 * This mirrors the rule the platform enforces server-side. The console holds a
 * copy so it can explain a routing decision before the call happens — "this
 * project can only reach `local`" — rather than only reporting the refusal
 * afterwards. It is a UI affordance, never the enforcement: the platform is the
 * authority, and the console never decides what may be sent.
 */
import { MAX_ZONES_BY_CLASSIFICATION } from '@aia/contracts';

export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const DATA_ZONES = ['local', 'br', 'us', 'eu', 'global'] as const;
export type DataZone = (typeof DATA_ZONES)[number];

/**
 * From the contract, not written here (ADR-027).
 *
 * The console SHOWS a project's effective policy, and a console whose idea of
 * the rule has drifted from the platform's would display a zone the router
 * refuses -- which reads as a bug in the router.
 */
const MAX_ZONES: Record<Classification, readonly DataZone[]> = MAX_ZONES_BY_CLASSIFICATION;

export function isClassification(value: string): value is Classification {
  return (CLASSIFICATIONS as readonly string[]).includes(value);
}

/** The zones a classification allows, before any further narrowing by policy. */
export function zonesFor(classification: Classification): DataZone[] {
  return [...MAX_ZONES[classification]];
}

/** An unknown classification fails CLOSED, exactly as the platform does. */
export function permits(classification: string, zone: DataZone): boolean {
  if (!isClassification(classification)) return false;
  return MAX_ZONES[classification].includes(zone);
}

/** True when the classification confines the project to the local model. */
export function isLocalOnly(classification: string): boolean {
  return isClassification(classification) && MAX_ZONES[classification].length === 1;
}

const LABELS: Record<Classification, string> = {
  public: 'Public',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
};

export function classificationLabel(classification: string): string {
  return isClassification(classification) ? LABELS[classification] : classification;
}
