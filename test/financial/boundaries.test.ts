import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { BUILD_LOCKS, executionGate, loadSafetyConfig } from '../../src/nexus/safety.js';
import { FINANCIAL_CAPABILITIES } from '../../src/financial/financial-types.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';

// docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §1–§2, §18, §55. Static checks: the gateway never imports execution, capital, risk, safety or model
// governance; models never import the gateway; the safety locks are unchanged; no execution capability or operation exists.

const ROOT = new URL('../../', import.meta.url);

// opportunity-types holds the shared Actor type only; the gateway may use it, nothing else from opportunities.
const FORBIDDEN_FROM_GATEWAY = [/broker/, /capital/, /risk/, /nexus\/safety/, /\/ai\//, /opportunities\/(?!opportunity-types)/];

function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(new URL(dir, ROOT))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: dir + f, text: readFileSync(new URL(dir + f, ROOT), 'utf8') }));
}

const importsOf = (text: string) => [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);

describe('static boundaries (§2, §18)', () => {
  it('the financial module has sources to check, so the scan below cannot pass vacuously', () => {
    expect(sources('src/financial/').length).toBeGreaterThan(0);
  });

  it('the gateway does not import the broker, capital, risk, safety, or model governance', () => {
    for (const { file, text } of sources('src/financial/')) {
      for (const spec of importsOf(text)) {
        const hit = FORBIDDEN_FROM_GATEWAY.find((rule) => rule.test(spec));
        expect({ file, spec, hit: hit?.source ?? null }).toEqual({ file, spec, hit: null });
      }
    }
  });

  it('no model adapter or model registry imports the financial gateway', () => {
    for (const { file, text } of sources('src/ai/')) {
      for (const spec of importsOf(text)) {
        expect({ file, spec, financial: /financial/.test(spec) }).toEqual({ file, spec, financial: false });
      }
    }
  });

  it('the gateway exposes no order, cancel, modify, transfer or withdrawal operation', () => {
    const names = Object.getOwnPropertyNames(FinancialDataGateway.prototype);
    for (const name of ['placeOrder', 'cancelOrder', 'modifyOrder', 'place', 'preview', 'transfer', 'withdraw']) {
      expect(names).not.toContain(name);
    }
  });

  it('the capability model holds no execution, transfer or position change', () => {
    for (const name of ['order_execution', 'money_transfer', 'withdrawal', 'position_change', 'place_order', 'submit_order']) {
      expect(FINANCIAL_CAPABILITIES as readonly string[]).not.toContain(name);
    }
  });
});

describe('safety locks regression (§55)', () => {
  it('the build locks are unchanged and frozen', () => {
    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true });
    expect(Object.isFrozen(BUILD_LOCKS)).toBe(true);
  });

  it('the default safety configuration stays paper with live trading disabled', () => {
    expect(loadSafetyConfig({})).toEqual({ tradingMode: 'paper', allowLiveTrading: false });
  });

  it('even an explicit live configuration cannot open the execution gate in this build', () => {
    const safety = loadSafetyConfig({ TRADING_MODE: 'live', ALLOW_LIVE_TRADING: 'true' });
    const gate = executionGate({ outcome: 'RECOMMEND', bucket: 'equities', safety });
    expect(gate.liveOrderAllowed).toBe(false);
    expect(gate.reasons).toContain('LIVE_TRADING_LOCKED_IN_BUILD');
    const physical = executionGate({ outcome: 'RECOMMEND', bucket: 'physical_trade', safety });
    expect(physical.physicalPurchaseAllowed).toBe(false);
    expect(physical.reasons).toContain('PHYSICAL_PURCHASE_LOCKED_IN_BUILD');
  });

  it('the migration set grows only by 012_financial_evidence.sql; 001-011 are still the earlier files', () => {
    const names = readdirSync(new URL('db/migrations/', ROOT)).filter((f) => /^\d{3}_/.test(f)).sort();
    expect(names.at(-1)).toBe('012_financial_evidence.sql');
    expect(names.slice(0, 11).at(-1)).toBe('011_universe_knowledge_seals.sql');
  });

  it('the Massive news connector imports no broker, capital, risk, execution or AI module, and exposes no order method', () => {
    const text = readFileSync(new URL('src/financial/massive-news-connector.ts', ROOT), 'utf8');
    for (const spec of importsOf(text)) {
      const hit = FORBIDDEN_FROM_GATEWAY.find((rule) => rule.test(spec));
      expect({ spec, hit: hit?.source ?? null }).toEqual({ spec, hit: null });
    }
    expect(text).not.toMatch(/placeOrder|cancelOrder|modifyOrder|submitOrder|transfer|withdraw/i);
  });

  it('the financial persistence, seal and verification modules import no broker, capital, risk or safety module', () => {
    const files = ['src/persistence/postgres/postgres-financial-evidence-store.ts', 'src/financial/financial-evidence.ts', 'src/financial/financial-evidence-store.ts', 'src/financial/financial-evidence-service.ts', 'src/financial/financial-knowledge.ts'];
    for (const file of files) {
      const text = readFileSync(new URL(file, ROOT), 'utf8');
      for (const spec of importsOf(text)) {
        const hit = FORBIDDEN_FROM_GATEWAY.find((rule) => rule.test(spec));
        expect({ file, spec, hit: hit?.source ?? null }).toEqual({ file, spec, hit: null });
      }
    }
  });
});
