import { ValidationError } from '@aia/errors';

/**
 * Immutable value object. It exists so the rest of the system never revalidates
 * a string each time it treats it as an email.
 */
export class Email {
  private constructor(readonly value: string) {}

  static of(raw: string): Email {
    const normalized = raw.trim().toLowerCase();
    // Deliberately simple: regex email validation is always incomplete; what
    // confirms an address is delivery, not its shape.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new ValidationError('Invalid email', { value: raw.slice(0, 64) });
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
