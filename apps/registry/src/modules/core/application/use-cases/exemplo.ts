import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '../ports.js';
import type { ExemploCommand, ExemploResult } from '../dto.js';

/**
 * Caso de uso de exemplo. Troque por um real e apague este.
 *
 * Regras do template (doc 03, secao 3.2):
 *   - recebe um comando, nunca o `Request` do Express;
 *   - fala so com ports;
 *   - todo caminho de erro tem teste.
 */
@Injectable()
export class Exemplo {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: ExemploCommand): Promise<ExemploResult> {
    void command;
    void this.clock;
    return Promise.resolve({ id: this.ids.next() });
  }
}
