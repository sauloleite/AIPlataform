import { ValidationError } from '@aia/errors';

export const CLASSIFICATIONS = ['publico', 'interno', 'confidencial', 'restrito'] as const;
export type ClassificationLevel = (typeof CLASSIFICATIONS)[number];

export const DATA_ZONES = ['local', 'br', 'us', 'eu', 'global'] as const;
export type DataZone = (typeof DATA_ZONES)[number];

/**
 * Zonas maximas por classificacao (ADR-010).
 *
 * A politica do projeto pode RESTRINGIR essa lista, nunca amplia-la: um projeto
 * `restrito` continua sem poder sair da maquina mesmo que alguem edite a politica.
 */
const MAX_ZONES: Record<ClassificationLevel, readonly DataZone[]> = {
  publico: ['local', 'br', 'us', 'eu', 'global'],
  interno: ['local', 'br', 'us', 'eu', 'global'],
  confidencial: ['local', 'br'],
  restrito: ['local'],
};

export class DataClassification {
  private constructor(readonly level: ClassificationLevel) {}

  static of(raw: string): DataClassification {
    if (!CLASSIFICATIONS.includes(raw as ClassificationLevel)) {
      throw new ValidationError('Classificacao de dados desconhecida', {
        value: raw,
        allowed: [...CLASSIFICATIONS],
      });
    }
    return new DataClassification(raw as ClassificationLevel);
  }

  /** Zonas permitidas por esta classificacao, antes de qualquer restricao. */
  allowedZones(): DataZone[] {
    return [...MAX_ZONES[this.level]];
  }

  permits(zone: DataZone): boolean {
    return MAX_ZONES[this.level].includes(zone);
  }

  /** Interseccao com as zonas pedidas: nunca amplia o que a classificacao permite. */
  restrictTo(requested: readonly DataZone[]): DataZone[] {
    return this.allowedZones().filter((zone) => requested.includes(zone));
  }

  get requiresLocalOnly(): boolean {
    return this.level === 'restrito';
  }

  toString(): string {
    return this.level;
  }
}
