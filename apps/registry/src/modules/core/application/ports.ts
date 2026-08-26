/**
 * Ports da camada de aplicacao.
 *
 * Interfaces, nunca classes concretas: o caso de uso nao sabe o que ha do outro
 * lado. Os Symbol existem porque o NestJS precisa de um token em runtime, e
 * interface some na compilacao.
 */

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('Clock');

export interface IdGenerator {
  next(): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');
