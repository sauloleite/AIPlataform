import { MAX_ZONES_BY_CLASSIFICATION } from '@aia/contracts';
import { ValidationError } from '@aia/errors';

export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type ClassificationLevel = (typeof CLASSIFICATIONS)[number];

export const DATA_ZONES = ['local', 'br', 'us', 'eu', 'global'] as const;
export type DataZone = (typeof DATA_ZONES)[number];

/**
 * Maximum zones per classification (ADR-010).
 *
 * A project policy may NARROW this list, never widen it: a `restricted` project
 * still cannot leave the machine even if someone edits its policy.
 *
 * From the contract, not written here (ADR-027). This service DECIDES a
 * project's zones, and the router ENFORCES them from its own copy of the same
 * rule -- so the two disagreeing would mean governance granting what the router
 * refuses, or worse, the other way round.
 */
const MAX_ZONES: Record<ClassificationLevel, readonly DataZone[]> = MAX_ZONES_BY_CLASSIFICATION;

export class DataClassification {
  private constructor(readonly level: ClassificationLevel) {}

  static of(raw: string): DataClassification {
    if (!CLASSIFICATIONS.includes(raw as ClassificationLevel)) {
      throw new ValidationError('Unknown data classification', {
        value: raw,
        allowed: [...CLASSIFICATIONS],
      });
    }
    return new DataClassification(raw as ClassificationLevel);
  }

  /** Zones this classification permits, before any further restriction. */
  allowedZones(): DataZone[] {
    return [...MAX_ZONES[this.level]];
  }

  permits(zone: DataZone): boolean {
    return MAX_ZONES[this.level].includes(zone);
  }

  /** Intersects with the requested zones: never widens what the level allows. */
  restrictTo(requested: readonly DataZone[]): DataZone[] {
    return this.allowedZones().filter((zone) => requested.includes(zone));
  }

  get requiresLocalOnly(): boolean {
    return this.level === 'restricted';
  }

  toString(): string {
    return this.level;
  }
}
