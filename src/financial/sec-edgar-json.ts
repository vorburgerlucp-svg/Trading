// The lexical JSON parser for SEC EDGAR responses (sec-exact-number:v1, docs/SEC_EDGAR_FUNDAMENTALS_V1.md §6). A binary float cannot carry a companyfacts val
// exactly, so a number keeps its source lexeme, and its canonical decimal is computed by moving the decimal point on digits. No binary arithmetic is used.
// Duplicate keys, deep nesting and out-of-bounds exponents fail closed. An error names the rule and never echoes the response.

import { FinancialGatewayError } from './financial-types.js';

export const SEC_EXACT_NUMBER_VERSION = 'sec-exact-number:v1';

const MAX_DEPTH = 64;
const MAX_EXPONENT = 1000;

/** A JSON number: its exact source lexeme and its canonical decimal. Only this class carries numbers; a JSON string is never read as one. */
export class SecNumber {
  constructor(
    readonly lexeme: string,
    readonly value: string,
  ) {
    Object.freeze(this);
  }
}

export function isSecNumber(value: unknown): value is SecNumber {
  return value instanceof SecNumber;
}

export type SecValue = string | boolean | null | SecNumber | SecValue[] | { [key: string]: SecValue };

function invalid(rule: string): never {
  throw new FinancialGatewayError('SCHEMA_INVALID', 'SEC response: ' + rule);
}

const NUMBER_SHAPE = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * The canonical decimal of a JSON number lexeme, exactly. Zero, with either sign, is "0". Leading and trailing zeros are removed, and an exponent moves
 * the decimal point, so 1e9 is "1000000000" and -2.5e-4 is "-0.00025". Negative zero is not preserved (docs §6).
 */
export function canonicalDecimalOf(lexeme: string): string {
  const match = NUMBER_SHAPE.exec(lexeme);
  if (!match) invalid('a number is not a JSON number');
  const [, sign = '', intDigits = '', fracDigits = '', expText] = match;
  const exponent = expText === undefined ? 0 : Number(expText);
  if (Math.abs(exponent) > MAX_EXPONENT) invalid('a number exponent is out of bounds');

  // The value is digits × 10^(point − digits.length), where point is the count of digits before the decimal point.
  let digits = intDigits + fracDigits;
  let point = intDigits.length + exponent;
  let lead = 0;
  while (lead < digits.length - 1 && digits[lead] === '0') lead++;
  digits = digits.slice(lead);
  point -= lead;
  if (digits === '0') return '0';

  let end = digits.length;
  while (end > 1 && digits[end - 1] === '0') end--;
  const significant = digits.slice(0, end);
  const scale = point - significant.length;
  if (scale >= 0) return sign + significant + '0'.repeat(scale);
  const places = -scale;
  const whole = significant.length > places ? significant.slice(0, significant.length - places) : '0';
  const fraction = significant.length > places ? significant.slice(significant.length - places) : '0'.repeat(places - significant.length) + significant;
  return sign + whole + '.' + fraction;
}

const NUMBER_AT = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS: ReadonlyArray<readonly [string, boolean | null]> = [
  ['true', true],
  ['false', false],
  ['null', null],
];
const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

class Scanner {
  private at = 0;

  constructor(private readonly text: string) {}

  parse(): SecValue {
    this.skipWhitespace();
    const value = this.valueAt(0);
    this.skipWhitespace();
    if (this.at !== this.text.length) invalid('the document has content after the value');
    return value;
  }

  private valueAt(depth: number): SecValue {
    const c = this.text[this.at];
    if (c === '{') return this.objectAt(depth + 1);
    if (c === '[') return this.arrayAt(depth + 1);
    if (c === '"') return this.stringAt();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.numberAt();
    for (const [word, value] of LITERALS) {
      if (this.text.startsWith(word, this.at)) {
        this.at += word.length;
        return value;
      }
    }
    return invalid('an unexpected character or the end of the document');
  }

  private objectAt(depth: number): Record<string, SecValue> {
    if (depth > MAX_DEPTH) invalid('the nesting is too deep');
    this.at++;
    const out: Record<string, SecValue> = Object.create(null) as Record<string, SecValue>;
    this.skipWhitespace();
    if (this.text[this.at] === '}') {
      this.at++;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.at] !== '"') invalid('an object key must be a string');
      const key = this.stringAt();
      if (key in out) invalid('an object has a duplicate key');
      this.skipWhitespace();
      if (this.text[this.at] !== ':') invalid('an object key must be followed by a colon');
      this.at++;
      this.skipWhitespace();
      out[key] = this.valueAt(depth);
      this.skipWhitespace();
      const c = this.text[this.at];
      if (c === ',') {
        this.at++;
        continue;
      }
      if (c === '}') {
        this.at++;
        return out;
      }
      return invalid('an object must continue with a comma or close');
    }
  }

  private arrayAt(depth: number): SecValue[] {
    if (depth > MAX_DEPTH) invalid('the nesting is too deep');
    this.at++;
    const out: SecValue[] = [];
    this.skipWhitespace();
    if (this.text[this.at] === ']') {
      this.at++;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      out.push(this.valueAt(depth));
      this.skipWhitespace();
      const c = this.text[this.at];
      if (c === ',') {
        this.at++;
        continue;
      }
      if (c === ']') {
        this.at++;
        return out;
      }
      return invalid('an array must continue with a comma or close');
    }
  }

  private stringAt(): string {
    const start = this.at;
    this.at++;
    for (;;) {
      const c = this.text[this.at];
      if (c === undefined) invalid('a string is not terminated');
      if (c === '"') {
        this.at++;
        break;
      }
      if (c === '\\') {
        const escape = this.text[this.at + 1];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.at + 2, this.at + 6))) invalid('a unicode escape needs four hexadecimal digits');
          this.at += 6;
          continue;
        }
        if (escape === undefined || !ESCAPES.has(escape)) invalid('a string has an invalid escape sequence');
        this.at += 2;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) invalid('a control character appears inside a string');
      this.at++;
    }
    // The token is fully validated above, so the standard decoder reads only the escapes it allows.
    return JSON.parse(this.text.slice(start, this.at)) as string;
  }

  private numberAt(): SecNumber {
    NUMBER_AT.lastIndex = this.at;
    const match = NUMBER_AT.exec(this.text);
    if (!match) invalid('a number is not valid JSON');
    this.at = NUMBER_AT.lastIndex;
    return new SecNumber(match[0], canonicalDecimalOf(match[0]));
  }

  private skipWhitespace(): void {
    while (this.at < this.text.length && WHITESPACE.has(this.text[this.at]!)) this.at++;
  }
}

/** Parses one SEC JSON document. Numbers are exact (SecNumber). Duplicate keys, deep nesting and any non-JSON input are refused. */
export function parseSecJson(text: string): SecValue {
  return new Scanner(text).parse();
}
