import { describe, expect, it } from 'vitest';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import { verifyFinancialEvidence } from '../../src/financial/financial-evidence.js';
import { SEC_PROVIDER, SecEdgarFundamentalsConnector, secFetch, secUserAgentOf } from '../../src/financial/sec-edgar-fundamentals.js';
import { ResilientCaller } from '../../src/market-data/providers/resilience.js';
import { FUNDAMENTALS_REQUEST, secInstruments, secRegistry } from '../financial/sec-fixtures.js';

// OPTIONAL local smoke test (docs/SEC_EDGAR_FUNDAMENTALS_V1.md §27, §27b). It runs only when SEC_USER_AGENT holds a valid contact, and only in the live
// vitest project. It is never part of npm run check. It proves reachability, schema recognition and absence of the User-Agent from the evidence. It does
// not assert company content, and it never fabricates a contact. Without SEC_USER_AGENT the suite reports as skipped (NOT RUN).

const USER_AGENT = secUserAgentOf(process.env.SEC_USER_AGENT);

describe.skipIf(USER_AGENT === undefined)('SEC EDGAR fundamentals live smoke (needs SEC_USER_AGENT; not run in CI)', () => {
  it('SEC is reachable, the response is recognised, and the User-Agent does not leak into the evidence', async () => {
    const connector = new SecEdgarFundamentalsConnector({
      userAgent: USER_AGENT,
      fetch: secFetch,
      caller: new ResilientCaller(SEC_PROVIDER, { minIntervalMs: 125, timeoutMs: 15_000, maxAttempts: 2 }),
      clock: () => new Date(),
    });
    const gateway = new FinancialDataGateway({ registry: await secRegistry(), instruments: await secInstruments(), connectors: [connector], clock: () => new Date() });
    const evidence = await gateway.fetch(FUNDAMENTALS_REQUEST('2024-FY', new Date().toISOString(), 'USD', 'r-sec-live'));
    expect(() => verifyFinancialEvidence(evidence)).not.toThrow();
    expect(JSON.stringify(evidence)).not.toContain(USER_AGENT!);
  });
});
