// Builds real FinancialEvidence through the gateway, so every test starts from output the actual boundary produces, not a hand-written object. The
// three clocks are controlled separately: the connector clock (retrievedAt), the gateway clock (nexusReceivedAt, createdAt), and the request asOf.

import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import type { FinancialEvidence } from '../../src/financial/financial-evidence.js';
import { McpFinancialConnector } from '../../src/financial/mcp-transport.js';
import { AAPL_ID, change, FUNDAMENTALS_RAW, fakeMcp, instrumentRegistry, NEWS_RAW, PROVIDER, RESEARCH_ONLY, T0 } from './fixtures.js';

export interface EvidenceOptions {
  /** Gateway clock: becomes nexusReceivedAt and createdAt. */
  readonly nexusAt?: string;
  /** Connector clock: becomes retrievedAt. */
  readonly retrievedAt?: string;
  readonly requestId?: string;
  readonly asOf?: string;
  /** Overrides of the provider's fundamentals answer. */
  readonly raw?: Record<string, unknown>;
  /** Overrides the provider publication time (provenance, not knowledge time). */
  readonly providerPublishedAt?: string;
  readonly effectiveAt?: string;
  /** News headline (external text). */
  readonly headline?: string;
}

async function registryWith(connectorId: string, capabilities: Array<'fundamentals' | 'news'>): Promise<FinancialConnectorRegistry> {
  const registry = await FinancialConnectorRegistry.open();
  await registry.register({ connectorId, provider: PROVIDER, transport: 'mcp', capabilities, license: RESEARCH_ONLY, mode: 'RESEARCH' }, change());
  await registry.enable(connectorId, change());
  return registry;
}

/** A fundamentals evidence record for AAPL, produced by the gateway from the fixture provider. */
export async function fundamentalsEvidence(o: EvidenceOptions = {}): Promise<FinancialEvidence> {
  const fake = fakeMcp({ get_company_fundamentals: { ...FUNDAMENTALS_RAW, ...o.raw } });
  const connector = new McpFinancialConnector({
    connectorId: 'fund-mcp',
    provider: PROVIDER,
    serverId: 'srv-1',
    client: fake.client,
    tools: { fundamentals: 'get_company_fundamentals' },
    map: (_capability, raw) => {
      const r = raw as Record<string, unknown>;
      return { candidate: raw, providerSymbol: 'AAPL', providerPublishedAt: o.providerPublishedAt ?? (r.publishedAt as string), effectiveAt: o.effectiveAt ?? (r.effectiveAt as string) };
    },
    clock: () => new Date(o.retrievedAt ?? T0),
  });
  const registry = await registryWith('fund-mcp', ['fundamentals']);
  const gateway = new FinancialDataGateway({ registry, instruments: await instrumentRegistry(), connectors: [connector], clock: () => new Date(o.nexusAt ?? T0) });
  return gateway.fetch({ requestId: o.requestId ?? 'r-1', capability: 'fundamentals', connectorId: 'fund-mcp', asOf: o.asOf ?? T0, environment: 'research', instrumentId: AAPL_ID, currency: 'USD', period: '2025-Q4' });
}

/** A news evidence record for AAPL. The headline is external text and goes through quarantine. */
export async function newsEvidence(o: EvidenceOptions = {}): Promise<FinancialEvidence> {
  const headline = o.headline ?? 'Apple reports quarterly results';
  const fake = fakeMcp({ search_company_news: { ...NEWS_RAW, headline } });
  const connector = new McpFinancialConnector({
    connectorId: 'news-mcp',
    provider: PROVIDER,
    serverId: 'srv-1',
    client: fake.client,
    tools: { news: 'search_company_news' },
    map: (_capability, raw) => {
      const r = raw as Record<string, unknown>;
      return {
        candidate: { articleId: r.articleId, publisher: r.publisher, publishedAt: r.publishedAt, url: r.url },
        providerPublishedAt: r.publishedAt as string,
        textBlocks: [{ source: String(r.publisher), text: String(r.headline ?? '') }],
      };
    },
    clock: () => new Date(o.retrievedAt ?? T0),
  });
  const registry = await registryWith('news-mcp', ['news']);
  const gateway = new FinancialDataGateway({ registry, instruments: await instrumentRegistry(), connectors: [connector], clock: () => new Date(o.nexusAt ?? T0) });
  return gateway.fetch({ requestId: o.requestId ?? 'r-n', capability: 'news', connectorId: 'news-mcp', asOf: o.asOf ?? T0, environment: 'research', instrumentId: AAPL_ID });
}
