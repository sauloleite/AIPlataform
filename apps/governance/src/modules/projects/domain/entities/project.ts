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
  /** LGPD: legal basis and purpose are mandatory at registration (doc 02 §10.2). */
  legalBasis: string;
  purpose: string;
  costCenter?: string;
  ownerPrincipalId?: string;
  allowedZones: DataZone[];
  modelRules: ModelRule[];
  maxConcurrentRequests: number;
  contentCapture: boolean;
  contentRetentionDays: number;
  policyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Reference doc 02 §10.2: conversation content, ninety days by default. */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Ten years.
 *
 * Not a technical limit. Keeping personal data for longer is a decision with a
 * legal basis behind it, and a platform that lets somebody type 99999 into a
 * form has made that decision on their behalf.
 */
const MAX_RETENTION_DAYS = 3650;

/**
 * The project IS the tenant (reference doc 02, principle 2).
 *
 * Budget, model policy, data classification and audit are all functions of the
 * project. No platform data exists outside one.
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
        'Slug must be 3 to 64 lowercase characters, starting and ending alphanumeric',
        { slug: input.slug },
      );
    }
    if (input.legalBasis.trim() === '' || input.purpose.trim() === '') {
      throw new ValidationError(
        'Legal basis and purpose are required: without them the processing cannot be justified (LGPD)',
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
      // Starts at the maximum the classification allows; policy only narrows it.
      allowedZones: input.classification.allowedZones(),
      modelRules: [],
      maxConcurrentRequests: 20,
      contentCapture: false,
      contentRetentionDays: DEFAULT_RETENTION_DAYS,
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

  get contentRetentionDays(): number {
    return this.props.contentRetentionDays;
  }

  get policyVersion(): number {
    return this.props.policyVersion;
  }

  /** Narrows the zones. Asking for a zone the classification forbids does not enable it. */
  restrictZones(requested: DataZone[], now: Date = new Date()): void {
    const effective = this.props.classification.restrictTo(requested);
    if (effective.length === 0) {
      throw new ValidationError(
        'The requested restriction would leave the project with no usable zone',
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
    if (value < 1) throw new ValidationError('Maximum concurrency must be at least 1');
    this.props.maxConcurrentRequests = value;
    this.touchPolicy(now);
  }

  /**
   * Enables recording prompt and response in the audit trail.
   *
   * A `restricted` project may not: retaining content at that classification
   * would demand controls this platform does not offer today (doc 02 §10.2).
   */
  setContentCapture(enabled: boolean, now: Date = new Date()): void {
    if (enabled && this.props.classification.requiresLocalOnly) {
      throw new ValidationError(
        'A project classified as restricted cannot record conversation content',
        { classification: this.props.classification.level },
      );
    }
    this.props.contentCapture = enabled;
    this.touchPolicy(now);
  }

  /**
   * How long this project's audit records are kept.
   *
   * A project decision rather than a service setting, because it is a decision
   * about personal data: reference doc 02 §10.2 asks for ninety days by default
   * and configurable per project, and the LGPD procedure needs a handle it can
   * act on. It was an environment variable per service, so every project in a
   * deployment kept its content for exactly as long as every other.
   */
  setContentRetentionDays(days: number, now: Date = new Date()): void {
    if (!Number.isInteger(days) || days < 1) {
      throw new ValidationError('Retention must be a whole number of days, at least 1');
    }
    if (days > MAX_RETENTION_DAYS) {
      throw new ValidationError(
        `Retention above ${MAX_RETENTION_DAYS.toString()} days needs a decision this platform does not make for you`,
        { max_days: MAX_RETENTION_DAYS },
      );
    }
    this.props.contentRetentionDays = days;
    this.touchPolicy(now);
  }

  isAliasAllowed(alias: string): boolean {
    const rule = this.props.modelRules.find((candidate) => candidate.alias === alias);
    // With no explicit rule the alias is allowed: the list exists for exceptions.
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
