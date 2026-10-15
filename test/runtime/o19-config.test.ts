// The IBKR part of the runtime configuration: off by default, loopback HTTPS only, no secret in any message or summary.
import { describe, expect, it } from 'vitest';
import { RuntimeConfigError, loadRuntimeConfig, summarizeRuntimeConfig } from '../../src/runtime/config.js';

const BASE = { DATABASE_URL: 'postgres://nexus:pw-o19-hidden@127.0.0.1:5432/nexus', PORT: '3000' };

function codeOf(env: Record<string, string>): { code: string; message: string } | null {
  try {
    loadRuntimeConfig({ ...BASE, ...env });
    return null;
  } catch (error) {
    if (error instanceof RuntimeConfigError) return { code: error.code, message: error.message };
    throw error;
  }
}

describe('O19 IBKR configuration', () => {
  it('IBKR is off by default: no URL, no account, and the summary says not configured', () => {
    const config = loadRuntimeConfig(BASE);
    expect(config.ibkr).toEqual({ enabled: false, baseUrl: null, accountId: null, caCertPath: null, allowBrokerageInit: false });
    expect(summarizeRuntimeConfig(config).ibkr).toBe('not_configured');
  });

  it('the brokerage initialization gate is closed by default; only IBKR_ALLOW_BROKERAGE_INIT=1 opens it, and only as written', () => {
    expect(loadRuntimeConfig({ ...BASE, IBKR_ENABLED: '1' }).ibkr.allowBrokerageInit).toBe(false);
    expect(loadRuntimeConfig({ ...BASE, IBKR_ENABLED: '1', IBKR_ALLOW_BROKERAGE_INIT: '0' }).ibkr.allowBrokerageInit).toBe(false);
    expect(loadRuntimeConfig({ ...BASE, IBKR_ENABLED: '1', IBKR_ALLOW_BROKERAGE_INIT: '1' }).ibkr.allowBrokerageInit).toBe(true);
  });

  it('the initialization gate accepts exactly 1 or 0: true, yes and other spellings are refused, never read as open', () => {
    for (const value of ['true', 'yes', 'on', '2', 'TRUE']) {
      expect(codeOf({ IBKR_ENABLED: '1', IBKR_ALLOW_BROKERAGE_INIT: value })?.message).toContain('IBKR_ALLOW_BROKERAGE_INIT must be 1 or 0');
    }
  });

  it('enabled with nothing else uses the local gateway default', () => {
    const config = loadRuntimeConfig({ ...BASE, IBKR_ENABLED: '1' });
    expect(config.ibkr).toMatchObject({ enabled: true, baseUrl: 'https://localhost:5000/v1/api' });
    expect(summarizeRuntimeConfig(config).ibkr).toBe('read_only_enabled');
  });

  it('the base URL must be loopback HTTPS on the gateway path: plain HTTP, a remote host, credentials, a query or another path are refused', () => {
    expect(codeOf({ IBKR_ENABLED: '1', IBKR_BASE_URL: 'http://localhost:5000/v1/api' })?.code).toBe('CONFIG_INVALID');
    expect(codeOf({ IBKR_ENABLED: '1', IBKR_BASE_URL: 'https://ibkr.example.com/v1/api' })?.message).toContain('loopback');
    expect(codeOf({ IBKR_ENABLED: '1', IBKR_BASE_URL: 'https://user:pw-o19-hidden@localhost:5000/v1/api' })?.message).toContain('credentials');
    expect(codeOf({ IBKR_ENABLED: '1', IBKR_BASE_URL: 'https://localhost:5000/v1/api?token=x' })?.message).toContain('query');
    expect(codeOf({ IBKR_ENABLED: '1', IBKR_BASE_URL: 'https://localhost:5000/v1/other' })?.message).toContain('/v1/api');
  });

  it('a refusal never echoes the URL or the password it refused', () => {
    const refusal = codeOf({ IBKR_ENABLED: '1', IBKR_BASE_URL: 'https://user:pw-o19-hidden@localhost:5000/v1/api?x=1' });
    expect(refusal?.message).not.toContain('pw-o19-hidden');
    expect(refusal?.message).not.toContain('user:');
  });

  it('loopback names 127.0.0.1 and ::1 are accepted, and the account id must be a plain identifier', () => {
    expect(loadRuntimeConfig({ ...BASE, IBKR_ENABLED: '1', IBKR_BASE_URL: 'https://127.0.0.1:5000/v1/api' }).ibkr.baseUrl).toBe('https://127.0.0.1:5000/v1/api');
    expect(loadRuntimeConfig({ ...BASE, IBKR_ENABLED: '1', IBKR_BASE_URL: 'https://[::1]:5000/v1/api' }).ibkr.baseUrl).toBe('https://[::1]:5000/v1/api');
    expect(codeOf({ IBKR_ACCOUNT_ID: 'U 1234' })?.code).toBe('CONFIG_INVALID');
    expect(codeOf({ IBKR_ACCOUNT_ID: 'U'.repeat(33) })?.code).toBe('CONFIG_INVALID');
    expect(loadRuntimeConfig({ ...BASE, IBKR_ACCOUNT_ID: 'U1234567' }).ibkr.accountId).toBe('U1234567');
  });

  it('the enable flag is exactly 1 or 0', () => {
    expect(codeOf({ IBKR_ENABLED: 'true' })?.message).toContain('IBKR_ENABLED must be 1 or 0');
  });

  it('the loggable summary never contains the account id, the URL or the database password', () => {
    const config = loadRuntimeConfig({ ...BASE, IBKR_ENABLED: '1', IBKR_ACCOUNT_ID: 'U1234567', IBKR_CA_CERT_PATH: 'C:/certs/gateway.pem' });
    const text = JSON.stringify(summarizeRuntimeConfig(config));
    expect(text).not.toContain('U1234567');
    expect(text).not.toContain('localhost');
    expect(text).not.toContain('pw-o19-hidden');
    expect(text).not.toContain('gateway.pem');
  });

  it('no IBKR variable can unlock broker orders or live trading', () => {
    const config = loadRuntimeConfig({ ...BASE, IBKR_ENABLED: '1', IBKR_BASE_URL: 'https://localhost:5000/v1/api' });
    expect(config.tradingMode).toBe('paper');
    expect(config.allowLiveTrading).toBe(false);
    expect(codeOf({ IBKR_ENABLED: '1', TRADING_MODE: 'live' })?.code).toBe('LIVE_TRADING_REFUSED');
    expect(codeOf({ IBKR_ENABLED: '1', ALLOW_LIVE_TRADING: 'true' })?.code).toBe('LIVE_TRADING_REFUSED');
  });
});
