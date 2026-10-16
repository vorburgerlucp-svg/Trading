// The shared eToro key rule: printable ASCII without space or control character, 1 to ETORO_KEY_MAX_LENGTH characters. The runtime
// configuration and the transport apply the same rule; the configuration trims copy/paste whitespace, the transport changes nothing.
// A refusal never contains the value. All keys here are artificial markers.
import { describe, expect, it } from 'vitest';
import { BrokerError } from '../../../src/broker/broker-errors.js';
import { ETORO_KEY_MAX_LENGTH, isValidEtoroKey } from '../../../src/broker/etoro/etoro-credentials.js';
import { HttpsEtoroTransport, type EtoroFetch } from '../../../src/broker/etoro/etoro-transport.js';
import { RuntimeConfigError, loadRuntimeConfig } from '../../../src/runtime/config.js';
import { emptyDemoPortfolio } from './o20-fixture.js';

const BASE = { DATABASE_URL: 'postgres://nexus:pw@127.0.0.1:5432/nexus', ETORO_ENABLED: '1' };
const OTHER = 'ETORO-OTHER-KEY-MARKER-0001';

/** An artificial key of the given length: a recognizable prefix, padded with a printable character set incl. punctuation. */
function marker(length: number): string {
  const prefix = 'ETORO-TEST-MARKER-';
  let body = '';
  while (prefix.length + body.length < length) body += 'Ab9_-.~';
  return (prefix + body).slice(0, length);
}

const LONG_260 = marker(260);
const LONG_MAX = marker(ETORO_KEY_MAX_LENGTH);
const TOO_LONG = marker(ETORO_KEY_MAX_LENGTH + 1);
const INNER_SPACE = 'ETORO-TEST-MARKER inner-space';
const INNER_TAB = 'ETORO-TEST-MARKER\tinner-tab';
const CONTROL = 'ETORO-TEST-MARKER\u0007bell';
const DEL = 'ETORO-TEST-MARKER\u007fdel';
const NON_ASCII = 'ETORO-TEST-MARKER-ä';

const REFUSED: ReadonlyArray<[string, string]> = [
  ['longer than the maximum', TOO_LONG],
  ['empty', ''],
  ['an inner space', INNER_SPACE],
  ['an inner tab', INNER_TAB],
  ['a control character', CONTROL],
  ['DEL', DEL],
  ['a non-ASCII character', NON_ASCII],
];

function configRefusal(env: Record<string, string>): RuntimeConfigError {
  try {
    loadRuntimeConfig({ ...BASE, ...env });
  } catch (error) {
    if (error instanceof RuntimeConfigError) return error;
    throw error;
  }
  throw new Error('expected a RuntimeConfigError');
}

function transportRefusal(apiKey: string, userKey: string): BrokerError {
  try {
    new HttpsEtoroTransport({ credentials: { apiKey, userKey }, fetch: async () => new Response('{}') });
  } catch (error) {
    if (error instanceof BrokerError) return error;
    throw error;
  }
  throw new Error('expected a BrokerError');
}

describe('O20 eToro key rule: one shared bound', () => {
  it('the maximum length is 1024', () => {
    expect(ETORO_KEY_MAX_LENGTH).toBe(1024);
  });

  it('accepts 1, 260 and 1024 printable characters', () => {
    expect(isValidEtoroKey('x')).toBe(true);
    expect(LONG_260).toHaveLength(260);
    expect(isValidEtoroKey(LONG_260)).toBe(true);
    expect(LONG_MAX).toHaveLength(1024);
    expect(isValidEtoroKey(LONG_MAX)).toBe(true);
  });

  it.each(REFUSED)('refuses a key with %s', (_label, value) => {
    expect(isValidEtoroKey(value)).toBe(false);
  });

  it('refuses a value that is not a string', () => {
    expect(isValidEtoroKey(undefined)).toBe(false);
    expect(isValidEtoroKey(null)).toBe(false);
    expect(isValidEtoroKey(12345)).toBe(false);
  });
});

describe('O20 eToro key rule: runtime configuration', () => {
  it('accepts a 260 and a 1024 character user key and API key', () => {
    expect(loadRuntimeConfig({ ...BASE, ETORO_API_KEY: OTHER, ETORO_USER_KEY: LONG_260 }).etoro.userKey).toBe(LONG_260);
    expect(loadRuntimeConfig({ ...BASE, ETORO_API_KEY: LONG_MAX, ETORO_USER_KEY: LONG_MAX }).etoro).toMatchObject({ apiKey: LONG_MAX, userKey: LONG_MAX });
  });

  it('trims leading and trailing copy/paste whitespace, and the trimmed key is what it keeps', () => {
    const config = loadRuntimeConfig({ ...BASE, ETORO_API_KEY: ' \t' + OTHER + '\r\n', ETORO_USER_KEY: '  ' + LONG_260 + ' \n' });
    expect(config.etoro).toMatchObject({ apiKey: OTHER, userKey: LONG_260 });
  });

  it('a 1025 character key is refused, even after trimming whitespace around it', () => {
    expect(configRefusal({ ETORO_API_KEY: OTHER, ETORO_USER_KEY: TOO_LONG }).message).toContain('ETORO_USER_KEY has an invalid format');
    expect(configRefusal({ ETORO_API_KEY: ' ' + TOO_LONG + ' ', ETORO_USER_KEY: OTHER }).message).toContain('ETORO_API_KEY has an invalid format');
  });

  it('an empty or whitespace-only key is refused as missing', () => {
    expect(configRefusal({ ETORO_API_KEY: OTHER, ETORO_USER_KEY: '' }).code).toBe('CONFIG_INVALID');
    expect(configRefusal({ ETORO_API_KEY: '   ', ETORO_USER_KEY: OTHER }).message).toContain('ETORO_API_KEY and ETORO_USER_KEY are required');
  });

  it.each(REFUSED.filter(([, value]) => value !== ''))('a key with %s is CONFIG_INVALID, and the message never contains the key', (_label, value) => {
    for (const env of [{ ETORO_API_KEY: value, ETORO_USER_KEY: OTHER }, { ETORO_API_KEY: OTHER, ETORO_USER_KEY: value }]) {
      const refusal = configRefusal(env);
      expect(refusal.code).toBe('CONFIG_INVALID');
      expect(refusal.message).not.toContain(value);
      expect(refusal.message).not.toContain(OTHER);
      expect(refusal.message).not.toContain('ETORO-TEST-MARKER');
    }
  });
});

describe('O20 eToro key rule: transport', () => {
  it('accepts a 260 and a 1024 character key and sends it unchanged', async () => {
    const sent: Array<Record<string, string>> = [];
    const fetch: EtoroFetch = async (_url, init) => {
      sent.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify(emptyDemoPortfolio()), { status: 200 });
    };
    await new HttpsEtoroTransport({ credentials: { apiKey: LONG_MAX, userKey: LONG_260 }, fetch }).call('portfolio.demo');
    expect(sent[0]?.['x-api-key']).toBe(LONG_MAX);
    expect(sent[0]?.['x-user-key']).toBe(LONG_260);
  });

  it('does not trim: a key with surrounding whitespace is refused, not changed', () => {
    expect(transportRefusal(' ' + OTHER, OTHER).code).toBe('BROKER_AUTH_REQUIRED');
    expect(transportRefusal(OTHER, LONG_260 + '\n').code).toBe('BROKER_AUTH_REQUIRED');
  });

  it.each(REFUSED)('a key with %s is refused before any request, and the error never contains the key', (_label, value) => {
    let requests = 0;
    for (const [apiKey, userKey] of [[value, OTHER], [OTHER, value]] as const) {
      try {
        new HttpsEtoroTransport({ credentials: { apiKey, userKey }, fetch: async () => (requests++, new Response('{}')) });
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(BrokerError);
        const refusal = error as BrokerError;
        expect(refusal.code).toBe('BROKER_AUTH_REQUIRED');
        const text = refusal.message + ' ' + String(refusal.stack) + ' ' + JSON.stringify(refusal);
        if (value !== '') expect(text).not.toContain(value);
        expect(text).not.toContain(OTHER);
        expect(text).not.toContain('ETORO-TEST-MARKER');
      }
    }
    expect(requests).toBe(0);
  });
});
