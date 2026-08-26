/**
 * Application layer ports.
 *
 * Interfaces, never concrete classes: the use case does not know what is on the
 * other side. The Symbols exist because NestJS needs a runtime token, and an
 * interface disappears at compile time.
 */

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('Clock');

export interface IdGenerator {
  next(): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');
