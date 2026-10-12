import { describe, expect, it } from 'vitest';
import { MassiveNewsRestConnector } from '../../src/financial/massive-news-connector.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { EnvironmentSecretProvider } from '../../src/financial/secrets.js';
import { verifyFinancialEvidence } from '../../src/financial/financial-evidence.js';
import type { FetchLike } from '../../src/market-data/providers/resilience.js';
import { ResilientCaller } from '../../src/market-data/providers/resilience.js';
import { change, UNREVIEWED } from '../financial/fixtures.js';
import { MASSIVE_CONNECTOR, MASSIVE_PROVIDER, NEWS_REQUEST, massiveInstruments } from '../financial/massive-fixtures.js';

// OPTIONAL local smoke test (docs/MASSIVE_NEWS_CONNECTOR_V1.md §15). It runs only when MASSIVE_API_KEY is set, and only in the live vitest project. It is
// never part of npm run check. It asserts reachability, schema recognition and absence of secret leakage. It does not assert article content.

const KEY = process.env.MASSIVE_API_KEY;

describe.skipIf(!KEY)('Massive news live smoke (needs MASSIVE_API_KEY; not run in CI)', () => {
  it('the provider is reachable, the response is recognised, and no secret leaks into the output', async () => {
    const env = new EnvironmentSecretProvider(process.env);
    const connector = new MassiveNewsRestConnector({
      secrets: env,
      fetch: fetch as unknown as FetchLike,
      caller: new ResilientCaller(MASSIVE_PROVIDER, { timeoutMs: 15_000, maxAttempts: 2 }),
      clock: () => new Date(),
      limit: 3,
    });
    const registry = await FinancialConnectorRegistry.open();
    await registry.register({ connectorId: MASSIVE_CONNECTOR, provider: MASSIVE_PROVIDER, transport: 'rest', capabilities: ['news'], license: UNREVIEWED, mode: 'RESEARCH' }, change());
    await registry.enable(MASSIVE_CONNECTOR, change());
    const gateway = new FinancialDataGateway({ registry, instruments: await massiveInstruments(), connectors: [connector], clock: () => new Date() });
    const batch = await gateway.fetchBatch(NEWS_REQUEST('r-live'));
    for (const evidence of batch.evidence) {
      expect(() => verifyFinancialEvidence(evidence)).not.toThrow();
      expect(JSON.stringify(evidence)).not.toContain(KEY!);
    }
  });
});
