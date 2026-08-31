import { ValidationError } from '@aia/errors';

/**
 * A named credential for an endpoint the platform does not own.
 *
 * What it holds is a REFERENCE, never a secret. ADR-015 forbids a managed
 * vault as the default and puts secrets in files or environment variables
 * depending on where the platform runs; a connection says which one to look up
 * and how to present it, and nothing more. A database dump of this collection
 * hands over no usable credential.
 */

export const CONNECTION_KINDS = ['bearer', 'api_key', 'basic', 'none'] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/**
 * A secret's name, not a path.
 *
 * The file resolver reads `<dir>/<ref>`, so a ref containing a separator or a
 * `..` is a path traversal that reads whatever the process can — the private
 * signing key sits in the same container. Constrained here, at construction,
 * rather than in whichever adapter happens to be wired.
 */
export const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export interface ConnectionSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: ConnectionKind;
  readonly header: string;
  readonly secretRef: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateConnectionInput {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  description?: string;
  kind: ConnectionKind;
  header?: string;
  secretRef: string;
  now: Date;
}

export class Connection {
  private constructor(private props: ConnectionSnapshot) {}

  static create(input: CreateConnectionInput): Connection {
    if (!SLUG_PATTERN.test(input.slug)) {
      throw new ValidationError('A connection slug is lowercase, digits and dashes', {
        slug: input.slug,
      });
    }
    if (input.name.trim() === '') {
      throw new ValidationError('A connection needs a name');
    }

    const kind = input.kind;
    const secretRef = kind === 'none' ? '' : input.secretRef;

    // `none` is the deliberate way to say "this endpoint is open". Requiring a
    // secret ref for it would push people into inventing a placeholder, and a
    // placeholder that does not resolve looks exactly like a broken connection.
    if (kind !== 'none' && !SECRET_REF_PATTERN.test(secretRef)) {
      throw new ValidationError(
        'A secret reference is a name, not a path: letters, digits, dot, dash, underscore',
        { secret_ref: secretRef },
      );
    }

    return new Connection({
      id: input.id,
      projectId: input.projectId,
      slug: input.slug,
      name: input.name.trim(),
      ...(input.description !== undefined && { description: input.description }),
      kind,
      header: headerFor(kind, input.header),
      secretRef,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static rehydrate(snapshot: ConnectionSnapshot): Connection {
    return new Connection(snapshot);
  }

  get snapshot(): ConnectionSnapshot {
    return this.props;
  }

  get id(): string {
    return this.props.id;
  }

  get secretRef(): string {
    return this.props.secretRef;
  }

  get needsSecret(): boolean {
    return this.props.kind !== 'none';
  }

  /**
   * Turns a resolved secret into the header the endpoint expects.
   *
   * The secret arrives as an argument and is never stored on the entity: a
   * credential that lives in memory only for the length of one call is a
   * credential that cannot be serialised into a log by accident.
   */
  credentialWith(secret: string): { header: string; value: string } | null {
    switch (this.props.kind) {
      case 'none':
        return null;
      case 'bearer':
        return { header: this.props.header, value: `Bearer ${secret}` };
      case 'basic':
        // The secret is `user:password`; the endpoint expects it base64'd.
        return { header: this.props.header, value: `Basic ${btoa(secret)}` };
      case 'api_key':
        return { header: this.props.header, value: secret };
    }
  }
}

function headerFor(kind: ConnectionKind, requested: string | undefined): string {
  if (kind === 'bearer' || kind === 'basic') return 'Authorization';
  const header = (requested ?? '').trim();
  if (kind === 'none') return '';

  if (header === '') return 'Authorization';
  // A header name with a newline in it splits the request in two. Whoever
  // typed it chose the name; the platform decides it is a header name.
  if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) {
    throw new ValidationError('A header name is letters, digits and dashes', { header });
  }
  return header;
}
