import { describe, expect, it } from 'vitest';
import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { FinancialGatewayError } from '../../src/financial/financial-types.js';
import { APPROVED, change, HUMAN, RESEARCH_ONLY, SYSTEM, UNREVIEWED } from './fixtures.js';

// docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §4–§6, §9. New connectors start SHADOW or RESEARCH. Production needs a human, an approved license and a
// passed gate. A connector and external data cannot change their own rights.

const base = { connectorId: 'news-a', provider: 'fixture', transport: 'mcp' as const, capabilities: ['news'] as const };

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
  await expect(p).rejects.toBeInstanceOf(FinancialGatewayError);
}

describe('registration: new connectors start in SHADOW or RESEARCH, never PRODUCTION', () => {
  it('registration defaults to SHADOW and disabled', async () => {
    const r = await FinancialConnectorRegistry.open();
    const e = await r.register({ ...base, license: UNREVIEWED }, change());
    expect(e).toMatchObject({ connectorId: 'news-a', mode: 'SHADOW', enabled: false, license: UNREVIEWED });
  });

  it('a PRODUCTION mode at registration is refused', async () => {
    const r = await FinancialConnectorRegistry.open();
    await expectCode(r.register({ ...base, license: APPROVED, mode: 'PRODUCTION' as never }, change()), 'REGISTRATION_INVALID');
  });

  it('a capability without an implemented validator cannot be registered', async () => {
    const r = await FinancialConnectorRegistry.open();
    await expectCode(r.register({ ...base, capabilities: ['macro'], license: RESEARCH_ONLY }, change()), 'CAPABILITY_NOT_IMPLEMENTED');
  });

  it('execution capabilities do not exist: registering one is refused', async () => {
    const r = await FinancialConnectorRegistry.open();
    await expectCode(r.register({ ...base, capabilities: ['order_execution' as never], license: APPROVED }, change()), 'CAPABILITY_NOT_IMPLEMENTED');
  });

  it('a duplicate connector id is refused', async () => {
    const r = await FinancialConnectorRegistry.open();
    await r.register({ ...base, license: UNREVIEWED }, change());
    await expectCode(r.register({ ...base, license: UNREVIEWED }, change()), 'CONNECTOR_ALREADY_REGISTERED');
  });

  it('an approved license alone does not activate a connector: external data cannot change its own rights', async () => {
    const r = await FinancialConnectorRegistry.open();
    const e = await r.register({ ...base, license: APPROVED }, change());
    expect(e.mode).toBe('SHADOW');
  });
});

describe('human governance for production (§4, §9)', () => {
  async function registered(license: typeof APPROVED | typeof RESEARCH_ONLY = APPROVED) {
    const r = await FinancialConnectorRegistry.open();
    await r.register({ ...base, license }, change());
    await r.enable('news-a', change());
    return r;
  }

  it('a system actor cannot activate production', async () => {
    const r = await registered();
    await expectCode(r.activateProduction('news-a', change(SYSTEM), { passed: true, reasons: [] }), 'ACTIVATION_REQUIRES_HUMAN');
  });

  it('production requires an approved license', async () => {
    const r = await registered(RESEARCH_ONLY);
    await expectCode(r.activateProduction('news-a', change(HUMAN), { passed: true, reasons: [] }), 'LICENSE_NOT_ALLOWED');
  });

  it('production requires a passed schema and benchmark gate', async () => {
    const r = await registered();
    await expectCode(r.activateProduction('news-a', change(HUMAN), { passed: false, reasons: ['schema suite red'] }), 'ACTIVATION_GATE_FAILED');
  });

  it('production requires the connector to be enabled', async () => {
    const r = await FinancialConnectorRegistry.open();
    await r.register({ ...base, license: APPROVED }, change());
    await expectCode(r.activateProduction('news-a', change(HUMAN), { passed: true, reasons: [] }), 'CONNECTOR_DISABLED');
  });

  it('a human with an approved license and a passed gate activates PRODUCTION', async () => {
    const r = await registered();
    const e = await r.activateProduction('news-a', change(HUMAN, '2026-06-02T00:00:00.000Z'), { passed: true, reasons: [] });
    expect(e.mode).toBe('PRODUCTION');
  });

  it('enabling is a human act; disabling may also be a system safety action', async () => {
    const r = await FinancialConnectorRegistry.open();
    await r.register({ ...base, license: RESEARCH_ONLY }, change());
    await expectCode(r.enable('news-a', change(SYSTEM)), 'ACTIVATION_REQUIRES_HUMAN');
    await r.enable('news-a', change(HUMAN));
    const off = await r.disable('news-a', change(SYSTEM));
    expect(off.enabled).toBe(false);
  });

  it('the history of activations is append-only and carries the human actor and reason', async () => {
    const r = await registered();
    await r.activateProduction('news-a', change(HUMAN), { passed: true, reasons: [] });
    expect(r.history('news-a').map((h) => h.type)).toEqual(['registered', 'enabled', 'activated_production']);
    expect(r.history('news-a').at(-1)).toMatchObject({ by: HUMAN, reason: 'test' });
  });
});

describe('license distinction (§6, §15, §48)', () => {
  it('an unreviewed source is registered as unreviewed and never as production-approved', async () => {
    const r = await FinancialConnectorRegistry.open();
    const e = await r.register({ ...base, license: UNREVIEWED }, change());
    expect(e.license.status).toBe('unreviewed');
    await r.enable('news-a', change());
    await expectCode(r.activateProduction('news-a', change(HUMAN), { passed: true, reasons: [] }), 'LICENSE_NOT_ALLOWED');
  });
});
