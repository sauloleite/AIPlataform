import { describe, expect, it } from 'vitest';

import {
  ArithmeticError,
  MAX_EXPRESSION_LENGTH,
  evaluateArithmetic,
} from '../src/modules/tools/domain/services/arithmetic.js';

/**
 * The calculator built-in. The expression comes from a model, so the tests that
 * matter most are the ones proving it is arithmetic and nothing else.
 */

describe('what it evaluates', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 / 4', 2.5],
    ['10 % 4', 2],
    ['2 ^ 10', 1024],
    ['2 ** 10', 1024],
    ['1.5e3 + .5', 1500.5],
    ['sqrt(16) + abs(-3)', 7],
    ['round(3.14159, 2)', 3.14],
    ['min(4, 2, 8) + max(4, 2, 8)', 10],
    ['log(1000)', 3],
    ['log(8, 2)', 3],
    ['ln(e)', 1],
    ['floor(2.7) + ceil(2.1)', 5],
    ['cos(pi)', -1],
    ['PI', Number(Math.PI.toPrecision(15))],
  ])('%s = %s', (expression, expected) => {
    expect(evaluateArithmetic(expression)).toBe(expected);
  });

  it('binds a power tighter than a leading minus, as on paper', () => {
    expect(evaluateArithmetic('-2^2')).toBe(-4);
    expect(evaluateArithmetic('(-2)^2')).toBe(4);
  });

  it('reads a power right to left, and takes a negative exponent', () => {
    expect(evaluateArithmetic('2^3^2')).toBe(512);
    expect(evaluateArithmetic('2^-1')).toBe(0.5);
  });

  it('does not hand a model binary noise to repeat', () => {
    expect(evaluateArithmetic('0.1 + 0.2')).toBe(0.3);
  });
});

describe('what it refuses', () => {
  it.each([
    ['an empty expression', '   '],
    ['a character outside the grammar', '2 & 3'],
    ['an unknown name', 'process'],
    ['an unknown function', 'require(1)'],
    ['a property access', 'constructor.constructor'],
    ['a prototype name as a constant', 'constructor'],
    ['a prototype name as a function', 'toString(1)'],
    ['__proto__', '__proto__'],
    ['a string', '"1" + 1'],
    ['a dangling operator', '1 +'],
    ['an unclosed parenthesis', '(1 + 2'],
    ['a thousands separator', '1,000 + 1'],
    ['implicit multiplication', '2(3)'],
    ['the wrong number of arguments', 'sqrt(1, 2)'],
    ['a division by zero', '1 / 0'],
    ['a result out of range', '10 ^ 400'],
    ['the square root of a negative number', 'sqrt(-1)'],
  ])('%s', (_case, expression) => {
    expect(() => evaluateArithmetic(expression)).toThrow(ArithmeticError);
  });

  it('refuses an expression longer than the limit', () => {
    expect(() => evaluateArithmetic('1+'.repeat(MAX_EXPRESSION_LENGTH))).toThrow(/longer than/);
  });

  it('refuses nesting deep enough to exhaust the stack, with an error instead of a crash', () => {
    const deep = `${'('.repeat(200)}1${')'.repeat(200)}`;

    expect(() => evaluateArithmetic(deep)).toThrow(/nested too deeply/);
  });

  it('refuses a chain of unary minuses the same way', () => {
    expect(() => evaluateArithmetic(`${'-'.repeat(300)}1`)).toThrow(/nested too deeply/);
  });

  it('says where the unexpected character is, so the model can fix it', () => {
    expect(() => evaluateArithmetic('12 $ 3')).toThrow('Unexpected character "$" at position 4');
  });
});
