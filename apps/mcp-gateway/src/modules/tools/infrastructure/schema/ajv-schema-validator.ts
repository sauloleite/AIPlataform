import { Injectable } from '@nestjs/common';
// The NAMED export: `import Ajv from 'ajv'` resolves to the module namespace
// under NodeNext, which is not constructable.
import { Ajv, type ValidateFunction } from 'ajv';

import type { SchemaValidator } from '../../application/ports.js';

/**
 * JSON Schema validation with Ajv, behind the SchemaValidator port.
 *
 * Compiled schemas are cached by the tool's own schema object, because a
 * gateway validates the same handful of schemas on every call and compiling
 * one per invocation is the slowest way to do this.
 *
 * `strict: false` on purpose. Strict mode rejects keywords Ajv does not know,
 * and tool schemas arrive from a registry that accepts what providers publish --
 * refusing a tool because its schema carries a vendor annotation would turn a
 * security control into an outage.
 */
@Injectable()
export class AjvSchemaValidator implements SchemaValidator {
  private readonly ajv = new Ajv({
    strict: false,
    // Every failure, not the first: a model correcting itself needs to see all
    // of them, or it fixes one field per turn.
    allErrors: true,
    // Fills declared defaults, so a schema saying `{"limit": {"default": 10}}`
    // reaches the executor as the tool author intended.
    useDefaults: true,
  });

  private readonly compiled = new WeakMap<object, ValidateFunction | Error>();

  validate(input: { schema: Record<string, unknown>; value: unknown }): readonly string[] {
    const validator = this.compile(input.schema);

    // A schema that will not compile is a refusal, never a pass. Otherwise a
    // tool published with a broken schema becomes the one tool nobody checks --
    // precisely the tool an attacker would want.
    if (validator instanceof Error) {
      return [`the tool's own schema is not valid JSON Schema: ${validator.message}`];
    }

    if (validator(input.value)) return [];

    return (validator.errors ?? []).map((error) => {
      const where = error.instancePath === '' ? 'the arguments' : error.instancePath;
      return `${where} ${error.message ?? 'is invalid'}`;
    });
  }

  private compile(schema: Record<string, unknown>): ValidateFunction | Error {
    const cached = this.compiled.get(schema);
    if (cached !== undefined) return cached;

    try {
      const validator = this.ajv.compile(schema);
      this.compiled.set(schema, validator);
      return validator;
    } catch (error) {
      // Cached too: a broken schema would otherwise be recompiled, and fail,
      // on every single call.
      const failure = error instanceof Error ? error : new Error(String(error));
      this.compiled.set(schema, failure);
      return failure;
    }
  }
}
