/**
 * Specification pattern for authorisation (reference doc 03 §4).
 *
 * Access rules are objects composable with `and`, `or` and `not`, testable in
 * isolation and readable from their own name. A decision carries its reason,
 * which goes into the trace: audit needs to know WHY something was denied.
 */
export interface Decision {
  allowed: boolean;
  /** Short, stable explanation. Never carries PII. */
  reason: string;
}

export const allow = (reason: string): Decision => ({ allowed: true, reason });
export const deny = (reason: string): Decision => ({ allowed: false, reason });

export abstract class Specification<T> {
  abstract readonly name: string;
  abstract evaluate(subject: T): Decision;

  isSatisfiedBy(subject: T): boolean {
    return this.evaluate(subject).allowed;
  }

  and(other: Specification<T>): Specification<T> {
    return new AndSpecification(this, other);
  }

  or(other: Specification<T>): Specification<T> {
    return new OrSpecification(this, other);
  }

  not(): Specification<T> {
    return new NotSpecification(this);
  }
}

class AndSpecification<T> extends Specification<T> {
  readonly name: string;

  constructor(
    private readonly left: Specification<T>,
    private readonly right: Specification<T>,
  ) {
    super();
    this.name = `(${left.name} and ${right.name})`;
  }

  evaluate(subject: T): Decision {
    const leftDecision = this.left.evaluate(subject);
    // Short circuit: the reason from the first denial is the useful one.
    if (!leftDecision.allowed) return leftDecision;
    return this.right.evaluate(subject);
  }
}

class OrSpecification<T> extends Specification<T> {
  readonly name: string;

  constructor(
    private readonly left: Specification<T>,
    private readonly right: Specification<T>,
  ) {
    super();
    this.name = `(${left.name} or ${right.name})`;
  }

  evaluate(subject: T): Decision {
    const leftDecision = this.left.evaluate(subject);
    if (leftDecision.allowed) return leftDecision;
    const rightDecision = this.right.evaluate(subject);
    if (rightDecision.allowed) return rightDecision;
    return deny(`${leftDecision.reason}; ${rightDecision.reason}`);
  }
}

class NotSpecification<T> extends Specification<T> {
  readonly name: string;

  constructor(private readonly inner: Specification<T>) {
    super();
    this.name = `not ${inner.name}`;
  }

  evaluate(subject: T): Decision {
    const decision = this.inner.evaluate(subject);
    return decision.allowed
      ? deny(`denied by ${this.inner.name}`)
      : allow(`not ${this.inner.name}`);
  }
}

/** Builds a specification from a plain predicate. */
export function spec<T>(
  name: string,
  predicate: (subject: T) => boolean,
  denyReason: string,
): Specification<T> {
  return new (class extends Specification<T> {
    readonly name = name;
    evaluate(subject: T): Decision {
      return predicate(subject) ? allow(name) : deny(denyReason);
    }
  })();
}
