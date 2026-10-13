import { describe, expect, it } from 'vitest';
import { canonicalDecimalOf, isSecNumber, parseSecJson, SEC_EXACT_NUMBER_VERSION } from '../../src/financial/sec-edgar-json.js';

// docs/SEC_EDGAR_FUNDAMENTALS_V1.md §6 (hard gate SEC_EXACT_NUMBER_BLOCKER). The companyfacts val is a JSON number, and a binary float cannot carry
// it exactly. These tests pin the lexical parser: exact canonical decimals, unique keys, bounded depth, and errors that never echo the response.

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED';
  }
}

describe('exact canonical decimal (sec-exact-number:v1, §6)', () => {
  it('states its version', () => {
    expect(SEC_EXACT_NUMBER_VERSION).toBe('sec-exact-number:v1');
  });

  // The mandatory examples of the brief.
  it.each([
    ['0', '0'],
    ['-0', '0'],
    ['1', '1'],
    ['1.23', '1.23'],
    ['-1.23', '-1.23'],
    ['94930000000', '94930000000'],
    ['9007199254740993', '9007199254740993'],
    ['0.000001', '0.000001'],
    ['1e9', '1000000000'],
    ['-2.5e-4', '-0.00025'],
  ])('%s is exactly %s', (lexeme, canonical) => {
    expect(canonicalDecimalOf(lexeme)).toBe(canonical);
  });

  // Further normalisation: trailing fraction zeros, exponents of either sign, and the zero forms.
  it.each([
    ['1.0', '1'],
    ['100', '100'],
    ['1E+2', '100'],
    ['0.0', '0'],
    ['-0.0', '0'],
    ['0e999', '0'],
    ['1.50e1', '15'],
    ['123.4500', '123.45'],
    ['1e-3', '0.001'],
    ['12e-1', '1.2'],
    ['1e1000', '1' + '0'.repeat(1000)],
  ])('%s normalises to %s', (lexeme, canonical) => {
    expect(canonicalDecimalOf(lexeme)).toBe(canonical);
  });

  it('refuses an exponent beyond the bound of 1000 in either direction', () => {
    expect(codeOf(() => canonicalDecimalOf('1e1001'))).toBe('SCHEMA_INVALID');
    expect(codeOf(() => canonicalDecimalOf('1e-1001'))).toBe('SCHEMA_INVALID');
  });

  it('refuses a lexeme that is not a JSON number', () => {
    for (const bad of ['01', '+1', '.5', '1.', '1e', 'NaN', 'Infinity', '-', '', '1_000']) {
      expect(codeOf(() => canonicalDecimalOf(bad)), bad).toBe('SCHEMA_INVALID');
    }
  });
});

describe('lexical JSON parser (sec-exact-number:v1, §6)', () => {
  it('keeps the source lexeme and the canonical value on each number', () => {
    const v = parseSecJson('{"val":6.08,"fy":2024}') as Record<string, unknown>;
    expect(isSecNumber(v.val)).toBe(true);
    expect(v.val).toMatchObject({ lexeme: '6.08', value: '6.08' });
    expect(v.fy).toMatchObject({ lexeme: '2024', value: '2024' });
  });

  it('keeps a number beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const v = parseSecJson('{"val":9007199254740993}') as Record<string, { value: string }>;
    expect(v.val!.value).toBe('9007199254740993');
  });

  it('parses strings, booleans, null, arrays and nested objects as ordinary values', () => {
    expect(parseSecJson('{"a":"x\\u0041\\n","b":true,"c":null,"d":[1,"two",false],"e":{"f":{}}}')).toMatchObject({
      a: 'xA\n',
      b: true,
      c: null,
      d: [expect.objectContaining({ value: '1' }), 'two', false],
      e: { f: {} },
    });
  });

  it('decodes a surrogate pair in a string', () => {
    expect(parseSecJson('"\\ud83d\\ude00"')).toBe('\u{1F600}');
  });

  it('accepts the four JSON whitespace characters around a value', () => {
    expect(parseSecJson(' \n\t\r{ "a" : 1 }\r\n ')).toMatchObject({ a: { lexeme: '1' } });
  });

  it('refuses a duplicate key in the same object, at any depth', () => {
    expect(codeOf(() => parseSecJson('{"a":1,"a":2}'))).toBe('SCHEMA_INVALID');
    expect(codeOf(() => parseSecJson('{"x":{"a":1,"a":1}}'))).toBe('SCHEMA_INVALID');
    expect(codeOf(() => parseSecJson('[{"a":1},{"b":2,"b":3}]'))).toBe('SCHEMA_INVALID');
  });

  it('keeps "__proto__" as an ordinary key, with no prototype effect', () => {
    const v = parseSecJson('{"__proto__":"x"}') as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(['__proto__']);
    expect(v['__proto__']).toBe('x');
    expect(Object.getPrototypeOf(v)).toBeNull();
  });

  it('refuses malformed JSON', () => {
    const bad = [
      '01',
      '+1',
      '.5',
      '1.',
      '1e',
      'NaN',
      'Infinity',
      '-Infinity',
      '1e1001',
      '1 2',
      '[1,]',
      '{"a":1,}',
      '{"a" 1}',
      'tru',
      '"unterminated',
      '"bad \\x escape"',
      '"ctrl\u0001"',
      '"\\u12G4"',
      '',
      '   ',
      '{} trailing',
      '{"a":1} {"b":2}',
      '[',
      '{',
    ];
    for (const text of bad) {
      expect(codeOf(() => parseSecJson(text)), JSON.stringify(text)).toBe('SCHEMA_INVALID');
    }
  });

  it('bounds nesting at 64 levels', () => {
    expect(codeOf(() => parseSecJson('['.repeat(64) + ']'.repeat(64)))).toBeNull();
    expect(codeOf(() => parseSecJson('['.repeat(65) + ']'.repeat(65)))).toBe('SCHEMA_INVALID');
  });

  it('a parse error names the rule and never echoes the response', () => {
    const sentinel = 'SENTINEL_9f3a71';
    try {
      parseSecJson('{"' + sentinel + '":01}');
      expect.fail('expected a parse error');
    } catch (error) {
      expect((error as Error).message).not.toContain(sentinel);
      expect((error as Error).message).not.toContain('01');
      expect((error as { code?: string }).code).toBe('SCHEMA_INVALID');
    }
  });
});
