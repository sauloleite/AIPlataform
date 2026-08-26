import { ValidationError } from '@aia/errors';
import { type DataClassification, type DataZone } from '../value-objects/data-classification.js';

export interface ModelRule {
  alias: string;
  allowed: boolean;
  maxOutputTokens?: number;
}

export interface ProjectProps {
  id: string;
  slug: string;
  name: string;
  description?: string;
  classification: DataClassification;
  /** LGPD: base legal e finalidade sao obrigatorias no cadastro (doc 02, 10.2). */
  legalBasis: string;
  purpose: string;
  costCenter?: string;
  ownerPrincipalId?: string;
  allowedZones: DataZone[];
  modelRules: ModelRule[];
  maxConcurrentRequests: number;
  contentCapture: boolean;
  policyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * O projeto E o tenant (doc 02, principio 2).
 *
 * Orcamento, politicas de modelo, classificacao de dados e auditoria sao todos
 * funcao do projeto. Nenhum dado da plataforma existe fora de um.
 */
export class Project {
  private constructor(private props: ProjectProps) {}

  static rehydrate(props: ProjectProps): Project {
    return new Project(props);
  }

  static create(input: {
    id: string;
    slug: string;
    name: string;
    description?: string;
    classification: DataClassification;
    legalBasis: string;
    purpose: string;
    costCenter?: string;
    ownerPrincipalId?: string;
    now?: Date;
  }): Project {
    if (!SLUG_PATTERN.test(input.slug)) {
      throw new ValidationError(
        'Slug deve ter de 3 a 64 caracteres, minusculos, comecando e terminando em alfanumerico',
        { slug: input.slug },
      );
    }
    if (input.legalBasis.trim() === '' || input.purpose.trim() === '') {
      throw new ValidationError(
        'Base legal e finalidade sao obrigatorias: sem elas o tratamento nao pode ser justificado (LGPD)',
      );
    }

    const now = input.now ?? new Date();
    return new Project({
      id: input.id,
      slug: input.slug,
      name: input.name,
      ...(input.description !== undefined && { description: input.description }),
      classification: input.classification,
      legalBasis: input.legalBasis,
      purpose: input.purpose,
      ...(input.costCenter !== undefined && { costCenter: input.costCenter }),
      ...(input.ownerPrincipalId !== undefined && { ownerPrincipalId: input.ownerPrincipalId }),
      // Comeca com o maximo que a classificacao permite; a politica so restringe.
      allowedZones: input.classification.allowedZones(),
      modelRules: [],
      maxConcurrentRequests: 20,
      contentCapture: false,
      policyVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  get id(): string {
    return this.props.id;
  }

  get slug(): string {
    return this.props.slug;
  }

  get name(): string {
    return this.props.name;
  }

  get classification(): DataClassification {
    return this.props.classification;
  }

  get allowedZones(): readonly DataZone[] {
    return this.props.allowedZones;
  }

  get modelRules(): readonly ModelRule[] {
    return this.props.modelRules;
  }

  get maxConcurrentRequests(): number {
    return this.props.maxConcurrentRequests;
  }

  get contentCapture(): boolean {
    return this.props.contentCapture;
  }

  get policyVersion(): number {
    return this.props.policyVersion;
  }

  /** Restringe as zonas. Pedir uma zona proibida pela classificacao nao a habilita. */
  restrictZones(requested: DataZone[], now: Date = new Date()): void {
    const effective = this.props.classification.restrictTo(requested);
    if (effective.length === 0) {
      throw new ValidationError(
        'A restricao pedida deixaria o projeto sem nenhuma zona utilizavel',
        { requested, classification: this.props.classification.level },
      );
    }
    this.props.allowedZones = effective;
    this.touchPolicy(now);
  }

  setModelRules(rules: ModelRule[], now: Date = new Date()): void {
    this.props.modelRules = rules;
    this.touchPolicy(now);
  }

  setMaxConcurrentRequests(value: number, now: Date = new Date()): void {
    if (value < 1) throw new ValidationError('Concorrencia maxima deve ser pelo menos 1');
    this.props.maxConcurrentRequests = value;
    this.touchPolicy(now);
  }

  /**
   * Habilita a gravacao de prompt e resposta na auditoria.
   *
   * Projeto `restrito` nao pode: reter conteudo dessa classificacao exigiria
   * controles que a plataforma nao oferece hoje (doc 02, secao 10.2).
   */
  setContentCapture(enabled: boolean, now: Date = new Date()): void {
    if (enabled && this.props.classification.requiresLocalOnly) {
      throw new ValidationError(
        'Projeto com classificacao restrita nao pode gravar conteudo de conversa',
        { classification: this.props.classification.level },
      );
    }
    this.props.contentCapture = enabled;
    this.touchPolicy(now);
  }

  isAliasAllowed(alias: string): boolean {
    const rule = this.props.modelRules.find((candidate) => candidate.alias === alias);
    // Sem regra explicita, o alias e permitido: a lista existe para excecoes.
    return rule?.allowed ?? true;
  }

  maxOutputTokensFor(alias: string): number | undefined {
    return this.props.modelRules.find((rule) => rule.alias === alias)?.maxOutputTokens;
  }

  private touchPolicy(now: Date): void {
    this.props.policyVersion += 1;
    this.props.updatedAt = now;
  }

  toSnapshot(): ProjectProps {
    return {
      ...this.props,
      allowedZones: [...this.props.allowedZones],
      modelRules: this.props.modelRules.map((rule) => ({ ...rule })),
    };
  }
}
