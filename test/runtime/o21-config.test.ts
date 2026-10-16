// O21 configuration: ETORO_DEMO_EXECUTION_ENABLED is off by default, exactly 0 or 1, and needs eToro enabled in demo mode. It does
// not change trading mode, live trading or any build lock.
import { describe, expect, it } from 'vitest';
import { BUILD_LOCKS } from '../../src/nexus/safety.js';
import { RuntimeConfigError, loadRuntimeConfig, summarizeRuntimeConfig } from '../../src/runtime/config.js';

const BASE = { DATABASE_URL: 'postgres://nexus:pw-o21-hidden@127.0.0.1:5432/nexus' };
const ETORO = { ETORO_ENABLED: '1', ETORO_TRADING_MODE: 'demo', ETORO_API_KEY: 'O21-CONFIG-API-KEY', ETORO_USER_KEY: 'O21-CONFIG-USER-KEY' };

function refusal(env: Record<string, string>): RuntimeConfigError {
  try {
    loadRuntimeConfig({ ...BASE, ...env });
  } catch (error) {
    if (error instanceof RuntimeConfigError) return error;
    throw error;
  }
  throw new Error('expected a RuntimeConfigError');
}

describe('O21 config: ETORO_DEMO_EXECUTION_ENABLED', () => {
  it('is off by default, also with eToro enabled', () => {
    expect(loadRuntimeConfig(BASE).etoroDemoExecution).toEqual({ enabled: false });
    expect(loadRuntimeConfig({ ...BASE, ...ETORO }).etoroDemoExecution).toEqual({ enabled: false });
    expect(summarizeRuntimeConfig(loadRuntimeConfig({ ...BASE, ...ETORO })).etoroDemoExecution).toBe('disabled');
  });

  it('0 and an empty value are off', () => {
    expect(loadRuntimeConfig({ ...BASE, ...ETORO, ETORO_DEMO_EXECUTION_ENABLED: '0' }).etoroDemoExecution.enabled).toBe(false);
    expect(loadRuntimeConfig({ ...BASE, ...ETORO, ETORO_DEMO_EXECUTION_ENABLED: '' }).etoroDemoExecution.enabled).toBe(false);
  });

  it('1 with eToro enabled in demo mode is on', () => {
    const config = loadRuntimeConfig({ ...BASE, ...ETORO, ETORO_DEMO_EXECUTION_ENABLED: '1' });
    expect(config.etoroDemoExecution.enabled).toBe(true);
    expect(summarizeRuntimeConfig(config).etoroDemoExecution).toBe('enabled');
  });

  it.each(['true', 'yes', 'on', '2', ' 1', '1 ', 'TRUE', '01'])('any other value (%j) is CONFIG_INVALID', (value) => {
    const error = refusal({ ...ETORO, ETORO_DEMO_EXECUTION_ENABLED: value });
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('ETORO_DEMO_EXECUTION_ENABLED must be 1 or 0');
  });

  it('1 needs ETORO_ENABLED=1', () => {
    expect(refusal({ ETORO_DEMO_EXECUTION_ENABLED: '1', ETORO_TRADING_MODE: 'demo' }).message).toContain('requires ETORO_ENABLED=1 and ETORO_TRADING_MODE=demo');
    expect(refusal({ ...ETORO, ETORO_ENABLED: '0', ETORO_DEMO_EXECUTION_ENABLED: '1' }).code).toBe('CONFIG_INVALID');
  });

  it('1 needs ETORO_TRADING_MODE=demo explicitly: unset is refused', () => {
    const { ETORO_TRADING_MODE: _mode, ...withoutMode } = ETORO;
    void _mode;
    expect(refusal({ ...withoutMode, ETORO_DEMO_EXECUTION_ENABLED: '1' }).message).toContain('ETORO_TRADING_MODE=demo');
  });

  it('a real eToro mode is refused at start, with or without execution', () => {
    expect(refusal({ ...ETORO, ETORO_TRADING_MODE: 'real', ETORO_DEMO_EXECUTION_ENABLED: '1' }).code).toBe('LIVE_TRADING_REFUSED');
    expect(refusal({ ...ETORO, ETORO_TRADING_MODE: 'live', ETORO_DEMO_EXECUTION_ENABLED: '1' }).code).toBe('CONFIG_INVALID');
  });

  it('does not change trading mode, live trading or any build lock', () => {
    const before = JSON.stringify(BUILD_LOCKS);
    const config = loadRuntimeConfig({ ...BASE, ...ETORO, ETORO_DEMO_EXECUTION_ENABLED: '1' });
    expect(config.tradingMode).toBe('paper');
    expect(config.allowLiveTrading).toBe(false);
    expect(summarizeRuntimeConfig(config)).toMatchObject({ tradingMode: 'paper', liveTrading: 'locked' });
    expect(JSON.stringify(BUILD_LOCKS)).toBe(before);
    expect(BUILD_LOCKS).toMatchObject({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: true });
    expect(refusal({ ...ETORO, ETORO_DEMO_EXECUTION_ENABLED: '1', TRADING_MODE: 'live' }).code).toBe('LIVE_TRADING_REFUSED');
    expect(refusal({ ...ETORO, ETORO_DEMO_EXECUTION_ENABLED: '1', ALLOW_LIVE_TRADING: 'true' }).code).toBe('LIVE_TRADING_REFUSED');
  });

  it('no message or summary contains a key or the database password', () => {
    const text = JSON.stringify(summarizeRuntimeConfig(loadRuntimeConfig({ ...BASE, ...ETORO, ETORO_DEMO_EXECUTION_ENABLED: '1' }))) + refusal({ ...ETORO, ETORO_DEMO_EXECUTION_ENABLED: 'x' }).message;
    expect(text).not.toContain('O21-CONFIG-API-KEY');
    expect(text).not.toContain('O21-CONFIG-USER-KEY');
    expect(text).not.toContain('pw-o21-hidden');
  });
});
