import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '../ports.js';
import type { ExampleCommand, ExampleResult } from '../dto.js';

/**
 * Placeholder use case. Replace it with a real one and delete this.
 *
 * Template rules (reference doc 03 §3.2):
 *   - it takes a command, never the Express `Request`;
 *   - it talks only to ports;
 *   - every error path has a test.
 */
@Injectable()
export class Example {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: ExampleCommand): Promise<ExampleResult> {
    void command;
    void this.clock;
    return Promise.resolve({ id: this.ids.next() });
  }
}
