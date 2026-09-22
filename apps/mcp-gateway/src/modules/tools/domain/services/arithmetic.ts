/**
 * The calculator built-in: arithmetic, parsed rather than evaluated.
 *
 * The expression comes from a model, which comes from a user, so `eval` or
 * `new Function` would be remote code execution with extra steps. This is a
 * recursive-descent parser over a closed grammar: anything that is not a
 * number, an operator, a listed function or a listed constant is refused.
 *
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/' | '%') unary)*
 *   unary      := ('+' | '-') unary | power
 *   power      := primary ('^' unary)?
 *   primary    := number | constant | name '(' arguments ')' | '(' expression ')'
 *
 * `power` takes a `unary` on its right, so `2^-1` is a half and `2^3^2` is
 * 2^9; `unary` sits above `power`, so `-2^2` is -4, as it is on paper.
 */

export const MAX_EXPRESSION_LENGTH = 500;

/** Deep enough for anything a person writes; shallow enough not to blow the stack. */
const MAX_DEPTH = 64;

// Maps, not object literals: `FUNCTIONS['constructor']` on a literal finds
// Object's own, and a model writing `toString(1)` would reach the prototype.
const CONSTANTS: ReadonlyMap<string, number> = new Map([
  ['pi', Math.PI],
  ['e', Math.E],
]);

interface ArithmeticFunction {
  readonly arity: readonly [number, number];
  readonly apply: (args: readonly number[]) => number;
}

const FUNCTIONS: ReadonlyMap<string, ArithmeticFunction> = new Map<string, ArithmeticFunction>([
  ['sqrt', { arity: [1, 1], apply: ([x = NaN]) => Math.sqrt(x) }],
  ['abs', { arity: [1, 1], apply: ([x = NaN]) => Math.abs(x) }],
  ['floor', { arity: [1, 1], apply: ([x = NaN]) => Math.floor(x) }],
  ['ceil', { arity: [1, 1], apply: ([x = NaN]) => Math.ceil(x) }],
  [
    'round',
    {
      arity: [1, 2],
      apply: ([x = NaN, digits = 0]) => {
        const factor = 10 ** Math.trunc(digits);
        return Math.round(x * factor) / factor;
      },
    },
  ],
  ['min', { arity: [1, 100], apply: (args) => Math.min(...args) }],
  ['max', { arity: [1, 100], apply: (args) => Math.max(...args) }],
  [
    'log',
    {
      arity: [1, 2],
      apply: ([x = NaN, base]) =>
        base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base),
    },
  ],
  ['ln', { arity: [1, 1], apply: ([x = NaN]) => Math.log(x) }],
  ['exp', { arity: [1, 1], apply: ([x = NaN]) => Math.exp(x) }],
  ['sin', { arity: [1, 1], apply: ([x = NaN]) => Math.sin(x) }],
  ['cos', { arity: [1, 1], apply: ([x = NaN]) => Math.cos(x) }],
  ['tan', { arity: [1, 1], apply: ([x = NaN]) => Math.tan(x) }],
]);

/** Why an expression cannot be evaluated, in words a model can correct. */
export class ArithmeticError extends Error {}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'operator'; value: string };

export function evaluateArithmetic(expression: string): number {
  if (expression.trim() === '') throw new ArithmeticError('The expression is empty');
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new ArithmeticError(
      `The expression is longer than ${MAX_EXPRESSION_LENGTH.toString()} characters`,
    );
  }

  const parser = new Parser(tokenise(expression));
  const value = parser.parse();

  if (!Number.isFinite(value)) {
    throw new ArithmeticError(
      'The result is not a finite number (a division by zero, or out of range)',
    );
  }
  // Fifteen significant digits is what a double holds exactly. Beyond them is
  // binary noise, and a model shown 0.30000000000000004 repeats it verbatim.
  return Number(value.toPrecision(15));
}

function tokenise(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source.charAt(index);

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (number !== null) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      index += number[0].length;
      continue;
    }

    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
    if (name !== null) {
      tokens.push({ kind: 'name', value: name[0].toLowerCase() });
      index += name[0].length;
      continue;
    }

    // `**` is how most programming languages write a power, and a model trained
    // on code writes it that way as often as `^`.
    if (source.startsWith('**', index)) {
      tokens.push({ kind: 'operator', value: '^' });
      index += 2;
      continue;
    }

    if ('+-*/%^(),'.includes(char)) {
      tokens.push({ kind: 'operator', value: char });
      index += 1;
      continue;
    }

    throw new ArithmeticError(
      `Unexpected character "${char}" at position ${(index + 1).toString()}`,
    );
  }

  return tokens;
}

class Parser {
  private position = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): number {
    const value = this.expression();
    const extra = this.tokens[this.position];
    if (extra !== undefined) {
      throw new ArithmeticError(`Unexpected "${String(extra.value)}" after a complete expression`);
    }
    return value;
  }

  private expression(): number {
    return this.nested(() => {
      let value = this.term();
      while (this.peekOperator('+') || this.peekOperator('-')) {
        const operator = this.next().value;
        const right = this.term();
        value = operator === '+' ? value + right : value - right;
      }
      return value;
    });
  }

  private term(): number {
    let value = this.unary();
    while (this.peekOperator('*') || this.peekOperator('/') || this.peekOperator('%')) {
      const operator = this.next().value;
      const right = this.unary();
      if (operator === '*') value *= right;
      else if (operator === '/') value /= right;
      else value %= right;
    }
    return value;
  }

  private unary(): number {
    if (this.peekOperator('-')) {
      this.next();
      return this.nested(() => -this.unary());
    }
    if (this.peekOperator('+')) {
      this.next();
      return this.nested(() => this.unary());
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    if (!this.peekOperator('^')) return base;
    this.next();
    return base ** this.unary();
  }

  private primary(): number {
    const token = this.tokens[this.position];
    if (token === undefined) throw new ArithmeticError('The expression ends too early');

    if (token.kind === 'number') {
      this.next();
      return token.value;
    }

    if (token.kind === 'name') {
      this.next();
      if (this.peekOperator('(')) return this.call(token.value);

      const constant = CONSTANTS.get(token.value);
      if (constant === undefined) throw new ArithmeticError(`Unknown name "${token.value}"`);
      return constant;
    }

    if (token.value === '(') {
      this.next();
      const value = this.expression();
      this.expectOperator(')');
      return value;
    }

    throw new ArithmeticError(`Unexpected "${token.value}"`);
  }

  private call(name: string): number {
    const fn = FUNCTIONS.get(name);
    if (fn === undefined) throw new ArithmeticError(`Unknown function "${name}"`);

    this.expectOperator('(');
    const args: number[] = [];
    if (!this.peekOperator(')')) {
      args.push(this.expression());
      while (this.peekOperator(',')) {
        this.next();
        args.push(this.expression());
      }
    }
    this.expectOperator(')');

    const [least, most] = fn.arity;
    if (args.length < least || args.length > most) {
      const expected =
        least === most ? least.toString() : `${least.toString()} to ${most.toString()}`;
      throw new ArithmeticError(
        `${name} takes ${expected} argument(s), not ${args.length.toString()}`,
      );
    }
    return fn.apply(args);
  }

  private nested(parse: () => number): number {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new ArithmeticError('The expression is nested too deeply');
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  private peekOperator(value: string): boolean {
    const token = this.tokens[this.position];
    return token?.kind === 'operator' && token.value === value;
  }

  private expectOperator(value: string): void {
    if (!this.peekOperator(value)) {
      const found = this.tokens[this.position];
      throw new ArithmeticError(
        found === undefined
          ? `Expected "${value}" before the end`
          : `Expected "${value}", found "${String(found.value)}"`,
      );
    }
    this.next();
  }

  private next(): Token {
    const token = this.tokens[this.position];
    if (token === undefined) throw new ArithmeticError('The expression ends too early');
    this.position += 1;
    return token;
  }
}
