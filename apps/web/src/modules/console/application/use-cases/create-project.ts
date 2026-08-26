import { isClassification } from '../../domain/classification';
import { PlatformError } from '../../domain/errors';
import type { PlatformGateway, ProjectSummary } from '../ports';

export interface CreateProjectInput {
  slug: string;
  name: string;
  description?: string;
  dataClassification: string;
  legalBasis: string;
  purpose: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * Creates a project.
 *
 * The checks here duplicate the platform's on purpose. They exist so a typo
 * comes back as a field-level message instead of a round trip and a 400, and
 * they are NOT the enforcement — governance validates every one of these again,
 * and its answer is the one that decides. Where the two could drift, the legal
 * basis and purpose are the case that matters: LGPD art. 7 requires them, and
 * the platform refuses without them regardless of what the console does.
 */
export class CreateProject {
  constructor(private readonly platform: PlatformGateway) {}

  async execute(accessToken: string, input: CreateProjectInput): Promise<ProjectSummary> {
    const issues: string[] = [];

    if (!SLUG.test(input.slug)) {
      issues.push('slug: lowercase letters, digits and hyphens, 3 to 64 characters');
    }
    if (input.name.trim().length < 3) {
      issues.push('name: at least 3 characters');
    }
    if (!isClassification(input.dataClassification)) {
      issues.push('data_classification: public, internal, confidential or restricted');
    }
    if (input.legalBasis.trim() === '') {
      issues.push('legal_basis: required (LGPD art. 7)');
    }
    if (input.purpose.trim() === '') {
      issues.push('purpose: required (LGPD art. 7)');
    }

    if (issues.length > 0) {
      throw new PlatformError({
        type: 'https://aia.dev/errors/validation_failed',
        title: 'Invalid request',
        status: 400,
        detail: issues.join('; '),
        code: 'validation_failed',
        issues,
      });
    }

    return this.platform.createProject(accessToken, {
      slug: input.slug,
      name: input.name.trim(),
      ...(input.description !== undefined &&
        input.description.trim() !== '' && { description: input.description.trim() }),
      dataClassification: input.dataClassification,
      legalBasis: input.legalBasis.trim(),
      purpose: input.purpose.trim(),
    });
  }
}
