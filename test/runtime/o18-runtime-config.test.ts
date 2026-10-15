import { describe, expect, it } from 'vitest';
import { BUILD_LOCKS } from '../../src/nexus/safety.js';
import { RuntimeConfigError, loadRuntimeConfig, summarizeRuntimeConfig, type Environment } from '../../src/runtime/config.js';

const DB = 'postgres://nexus:correct-horse-battery@localhost:5432/nexus';
const KEY = 'ABCDEFGH12345678SECRETKEY';
const base: Environment = { DATABASE_URL: DB, TRADING_MODE: 'paper', ALLOW_LIVE_TRADING: 'false' };

function codeOf(env: Environment): string {
  try {
    loadRuntimeConfig(env);
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof RuntimeConfigError ? error.code : 'UNCLASSIFIED:' + String(error);
  }
}

describe('O18 runtime configuration (fail closed)', () => {
  it('a paper configuration with a database loads with safe defaults', () => {
    const config = loadRuntimeConfig(base);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.tradingMode).toBe('paper');
    expect(config.allowLiveTrading).toBe(false);
    expect(config.twelveData).toEqual({ apiKey: null, demo: false });
  });

  it('TRADING_MODE=live refuses the start, with or without ALLOW_LIVE_TRADING', () => {
    expect(codeOf({ ...base, TRADING_MODE: 'live' })).toBe('LIVE_TRADING_REFUSED');
    expect(codeOf({ ...base, TRADING_MODE: 'live', ALLOW_LIVE_TRADING: 'true' })).toBe('LIVE_TRADING_REFUSED');
  });

  it('ALLOW_LIVE_TRADING=true refuses the start, even with TRADING_MODE=paper', () => {
    expect(codeOf({ ...base, ALLOW_LIVE_TRADING: 'true' })).toBe('LIVE_TRADING_REFUSED');
  });

  it('a non-exact live flag or trading mode is an invalid configuration, never a live one', () => {
    expect(codeOf({ ...base, ALLOW_LIVE_TRADING: 'yes' })).toBe('CONFIG_INVALID');
    expect(codeOf({ ...base, ALLOW_LIVE_TRADING: 'TRUE' })).toBe('CONFIG_INVALID');
    expect(codeOf({ ...base, TRADING_MODE: 'backtest' })).toBe('CONFIG_INVALID');
  });

  it('a missing or non-postgres database URL is refused without echoing it', () => {
    const missing = { ...base, DATABASE_URL: undefined };
    expect(codeOf(missing)).toBe('CONFIG_INVALID');
    try {
      loadRuntimeConfig({ ...base, DATABASE_URL: 'mysql://user:secret-pass@host/db' });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret-pass');
    }
  });

  it('an invalid port or non-loopback host is refused', () => {
    expect(codeOf({ ...base, PORT: '0' })).toBe('CONFIG_INVALID');
    expect(codeOf({ ...base, PORT: '70000' })).toBe('CONFIG_INVALID');
    expect(codeOf({ ...base, PORT: '3000abc' })).toBe('CONFIG_INVALID');
    expect(codeOf({ ...base, HOST: 'bad host' })).toBe('CONFIG_INVALID');
    expect(codeOf({ ...base, HOST: '0.0.0.0' })).toBe('CONFIG_INVALID');
    expect(codeOf({ ...base, HOST: '192.168.1.10' })).toBe('CONFIG_INVALID');
    expect(loadRuntimeConfig({ ...base, HOST: 'localhost' }).host).toBe('localhost');
    expect(loadRuntimeConfig({ ...base, HOST: '::1' }).host).toBe('::1');
  });

  it('a malformed Twelve Data key is refused, and the error never echoes it', () => {
    try {
      loadRuntimeConfig({ ...base, TWELVE_DATA_API_KEY: 'bad key!' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigError);
      expect(String((error as Error).message)).not.toContain('bad key!');
    }
  });

  it('a production key is used and the demo flag is ignored while it is set; demo alone is labelled demo', () => {
    expect(loadRuntimeConfig({ ...base, TWELVE_DATA_API_KEY: KEY, NEXUS_TWELVE_DATA_DEMO: '1' }).twelveData).toEqual({ apiKey: KEY, demo: false });
    expect(loadRuntimeConfig({ ...base, NEXUS_TWELVE_DATA_DEMO: '1' }).twelveData).toEqual({ apiKey: null, demo: true });
  });

  it('the loggable summary never contains the database URL or any key', () => {
    const summary = summarizeRuntimeConfig(loadRuntimeConfig({ ...base, TWELVE_DATA_API_KEY: KEY }));
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain('correct-horse-battery');
    expect(serialized).not.toContain(DB);
    expect(summary).toMatchObject({ tradingMode: 'paper', liveTrading: 'locked', marketData: 'production' });
  });

  it('no environment variable can change the build locks, and the configuration has no field for them', () => {
    const before = JSON.stringify(BUILD_LOCKS);
    const config = loadRuntimeConfig({ ...base, BUILD_LOCKS: 'off', liveTrading: 'false' });
    expect(JSON.stringify(BUILD_LOCKS)).toBe(before);
    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true });
    expect(Object.keys(config)).not.toContain('buildLocks');
    expect(config.allowLiveTrading).toBe(false);
  });
});
