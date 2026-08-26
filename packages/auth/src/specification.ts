/**
 * Padrao Specification para autorizacao (doc 03, secao 4).
 *
 * Regras de acesso sao objetos combinaveis com `and`, `or` e `not`, testaveis
 * isoladamente e legiveis no proprio nome. Uma decisao carrega o motivo, que
 * vai para o trace: auditoria precisa saber POR QUE algo foi negado.
 */
export interface Decision {
  allowed: boolean;
  /** Explicacao curta e estavel. Nunca carrega PII. */
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
    // Curto-circuito: o motivo do primeiro que nega e o motivo util.
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
      ? deny(`negado por ${this.inner.name}`)
      : allow(`nao ${this.inner.name}`);
  }
}

/** Especificacao construida a partir de um predicado simples. */
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
