import { describe, expect, it } from 'vitest';
import { FinancialDataGateway, strongO1Eligible } from '../../src/financial/financial-gateway.js';
import { verifyFinancialEvidence } from '../../src/financial/financial-evidence.js';
import { SecSourceAttestor } from '../../src/financial/sec-source-attestation.js';
import { SEC_PROVIDER, SecEdgarFundamentalsConnector, secFetch, secUserAgentOf } from '../../src/financial/sec-edgar-fundamentals.js';
import { ResilientCaller } from '../../src/market-data/providers/resilience.js';
import { sealedWithoutDatabase } from '../financial/sec-attestation-fixtures.js';
import { FUNDAMENTALS_REQUEST, secInstruments, secRegistry } from '../financial/sec-fixtures.js';

// OPTIONAL local smoke test (docs/HISTORICAL_FINANCIAL_SOURCE_ATTESTATION_V1.md §28). It runs only when SEC_USER_AGENT holds a valid contact, and only in the
// live vitest project. It is never part of npm run check. It reconstructs the FY2024 Apple fundamentals from SEC, attests the filing, and checks the date
// policy and the decision_time refusal. It asserts no revenue or EPS value, and it never fabricates a contact.

const USER_AGENT = secUserAgentOf(process.env.SEC_USER_AGENT);

describe.skipIf(USER_AGENT === undefined)('SEC source attestation live smoke (needs SEC_USER_AGENT; not run in CI)', () => {
  it('attests the live FY2024 fundamentals and gives the research and decision_time results the policy requires', async () => {
    const caller = new ResilientCaller(SEC_PROVIDER, { minIntervalMs: 125, timeoutMs: 15_000, maxAttempts: 2 });
    const connector = new SecEdgarFundamentalsConnector({ userAgent: USER_AGENT, fetch: secFetch, caller, clock: () => new Date() });
    const registry = await secRegistry();
    const gateway = new FinancialDataGateway({ registry, instruments: await secInstruments(), connectors: [connector], clock: () => new Date() });
    const evidence = await gateway.fetch(FUNDAMENTALS_REQUEST('2024-FY', new Date().toISOString(), 'USD', 'r-sec-attest-live'));
    expect(() => verifyFinancialEvidence(evidence)).not.toThrow();

    const attestor = new SecSourceAttestor({ userAgent: USER_AGENT, fetch: secFetch, caller, clock: () => new Date(), instruments: await secInstruments() });
    const attestation = await attestor.attest(sealedWithoutDatabase(evidence));
    expect(attestation.sourceForm).toMatch(/^10-(Q|K)$/);
    expect(attestation.sourceFilingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(strongO1Eligible(evidence, null).eligible).toBe(false);
    expect(connector.connection()).toBe('connected');
  });
});
