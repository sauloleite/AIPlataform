import { ValidationError } from '@aia/errors';

/**
 * Value object imutavel. Existe para que o resto do sistema nao precise
 * revalidar uma string toda vez que a trata como email.
 */
export class Email {
  private constructor(readonly value: string) {}

  static of(raw: string): Email {
    const normalized = raw.trim().toLowerCase();
    // Deliberadamente simples: validacao de email por regex e sempre incompleta;
    // o que confirma um endereco e o envio, nao o formato.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new ValidationError('Email invalido', { value: raw.slice(0, 64) });
    }
    return new Email(normalized);
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
