// The eToro part of the runtime configuration: off by default, demo only, keys read only when enabled, and no key in any message or
// summary. The safety locks and the live-trading refusals of the build are unchanged.
import { describe, expect, it } from 'vitest';
import { BUILD_LOCKS } from '../../src/nexus/safety.js';
import { RuntimeConfigError, loadRuntimeConfig, summarizeRuntimeConfig } from '../../src/runtime/config.js';

const BASE = { DATABASE_URL: 'postgres://nexus:pw-o20-hidden@127.0.0.1:5432/nexus', PORT: '3000' };
const API_KEY = 'ETORO-KEY-CONFIG-0001';
const USER_KEY = 'ETORO-USER-CONFIG-0002';

function codeOf(env: Record<string, string>): { code: string; message: string } | null {
  try {
    loadRuntimeConfig({ ...BASE, ...env });
    return null;
  } catch (error) {
    if (error instanceof RuntimeConfigError) return { code: error.code, message: error.message };
    throw error;
  }
}

describe('O20 eToro configuration: off by default', () => {
  it('eToro is off by default: no keys are read, and the summary says not configured', () => {
    const config = loadRuntimeConfig({ ...BASE, ETORO_API_KEY: API_KEY, ETORO_USER_KEY: USER_KEY });
    expect(config.etoro).toEqual({ enabled: false, tradingMode: 'demo', apiKey: null, userKey: null });
    expect(summarizeRuntimeConfig(config).etoro).toBe('not_configured');
  });

  it('ETORO_ENABLED is exactly 1 or 0', () => {
    expect(codeOf({ ETORO_ENABLED: 'true' })?.message).toContain('ETORO_ENABLED must be 1 or 0');
    expect(codeOf({ ETORO_ENABLED: 'yes' })?.code).toBe('CONFIG_INVALID');
  });
});

describe('O20 eToro configuration: enabled needs both keys', () => {
  it('enabled with both keys reads them as server-side values, and the summary says demo read-only', () => {
    const config = loadRuntimeConfig({ ...BASE, ETORO_ENABLED: '1', ETORO_API_KEY: API_KEY, ETORO_USER_KEY: USER_KEY });
    expect(config.etoro).toEqual({ enabled: true, tradingMode: 'demo', apiKey: API_KEY, userKey: USER_KEY });
    expect(summarizeRuntimeConfig(config).etoro).toBe('demo_read_only');
  });

  it('enabled without a key is CONFIG_INVALID, and the message names the variables but no value', () => {
    const missing = codeOf({ ETORO_ENABLED: '1', ETORO_API_KEY: API_KEY });
    expect(missing?.code).toBe('CONFIG_INVALID');
    expect(missing?.message).toContain('ETORO_USER_KEY');
    expect(missing?.message).not.toContain(API_KEY);
  });

  it('a key with a space or a control character is CONFIG_INVALID, and the value is never echoed', () => {
    const refusal = codeOf({ ETORO_ENABLED: '1', ETORO_API_KEY: 'bad key ' + API_KEY, ETORO_USER_KEY: USER_KEY });
    expect(refusal?.message).toContain('ETORO_API_KEY has an invalid format');
    expect(refusal?.message).not.toContain(API_KEY);
  });

  it('keys set while eToro is disabled are not stored at all', () => {
    const config = loadRuntimeConfig({ ...BASE, ETORO_ENABLED: '0', ETORO_API_KEY: API_KEY, ETORO_USER_KEY: USER_KEY });
    expect(config.etoro.apiKey).toBeNull();
    expect(config.etoro.userKey).toBeNull();
  });
});

describe('O20 eToro configuration: demo only, real refused', () => {
  it('ETORO_TRADING_MODE=real is refused at start, even when eToro is disabled', () => {
    expect(codeOf({ ETORO_TRADING_MODE: 'real' })?.code).toBe('LIVE_TRADING_REFUSED');
    expect(codeOf({ ETORO_ENABLED: '1', ETORO_TRADING_MODE: 'real', ETORO_API_KEY: API_KEY, ETORO_USER_KEY: USER_KEY })?.code).toBe('LIVE_TRADING_REFUSED');
  });

  it('demo is accepted, and any other value is CONFIG_INVALID', () => {
    expect(loadRuntimeConfig({ ...BASE, ETORO_TRADING_MODE: 'demo' }).etoro.tradingMode).toBe('demo');
    expect(codeOf({ ETORO_TRADING_MODE: 'sandbox' })?.code).toBe('CONFIG_INVALID');
  });

  it('the refusal message names the variable and the rule, not a value', () => {
    expect(codeOf({ ETORO_TRADING_MODE: 'real' })?.message).toContain('ETORO_TRADING_MODE=real');
  });
});

describe('O20 eToro configuration: the safety invariants are unchanged', () => {
  it('trading mode stays paper, live trading stays off, and every build lock stays closed except the one demo cycle lock (O22 B1)', () => {
    const config = loadRuntimeConfig({ ...BASE, ETORO_ENABLED: '1', ETORO_API_KEY: API_KEY, ETORO_USER_KEY: USER_KEY });
    expect(config.tradingMode).toBe('paper');
    expect(config.allowLiveTrading).toBe(false);
    expect(summarizeRuntimeConfig(config)).toMatchObject({ tradingMode: 'paper', liveTrading: 'locked' });
    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: false });
  });

  it('no eToro variable can unlock live trading or an order', () => {
    expect(codeOf({ ETORO_ENABLED: '1', ETORO_API_KEY: API_KEY, ETORO_USER_KEY: USER_KEY, TRADING_MODE: 'live' })?.code).toBe('LIVE_TRADING_REFUSED');
    expect(codeOf({ ETORO_ENABLED: '1', ETORO_API_KEY: API_KEY, ETORO_USER_KEY: USER_KEY, ALLOW_LIVE_TRADING: 'true' })?.code).toBe('LIVE_TRADING_REFUSED');
  });

  it('the loggable summary never contains a key, the database password, or the account', () => {
    const config = loadRuntimeConfig({ ...BASE, ETORO_ENABLED: '1', ETORO_API_KEY: API_KEY, ETORO_USER_KEY: USER_KEY });
    const text = JSON.stringify(summarizeRuntimeConfig(config));
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(USER_KEY);
    expect(text).not.toContain('pw-o20-hidden');
  });
});
