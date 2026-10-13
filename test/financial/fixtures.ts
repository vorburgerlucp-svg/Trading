import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import type { Actor } from '../../src/opportunities/opportunity-types.js';
import { AAPL } from '../market-data/fixtures.js';
import { sequentialIds } from '../helpers.js';

// Shared fixtures for the Financial Connector Gateway (docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §23). No network: every provider is a fake client.

export const HUMAN: Actor = { kind: 'human', id: 'luc' };
export const SYSTEM: Actor = { kind: 'system', id: 'scheduler' };
export const T0 = '2026-06-01T10:00:00.000Z';
export const PROVIDER = 'fixture-mcp';
export const AAPL_ID = AAPL.instrumentId;

export const change = (by: Actor = HUMAN, at: string = T0) => ({ at, by, reason: 'test' });

export const APPROVED = { status: 'production_approved', redistribution: 'internal_only' } as const;
export const RESEARCH_ONLY = { status: 'research_only', redistribution: 'internal_only' } as const;
export const UNREVIEWED = { status: 'unreviewed', redistribution: 'unknown' } as const;
export const RESTRICTED = { status: 'restricted', redistribution: 'forbidden' } as const;

/** Instrument registry with AAPL mapped to the fixture provider's symbol 'AAPL' from 1980. */
export async function instrumentRegistry(): Promise<InstrumentRegistry> {
  const r = await InstrumentRegistry.open(new InMemoryAppendOnlyStore<InstrumentEvent>(), { newId: sequentialIds('i-') });
  await r.register({ ...AAPL }, change());
  await r.addMapping({ instrumentId: AAPL_ID, provider: PROVIDER, providerSymbol: 'AAPL', validFrom: '1980-12-12T00:00:00Z' }, change());
  return r;
}

/** A fake MCP read client. It records every call, and it answers only the tools it was given. */
export function fakeMcp(answers: Record<string, unknown | (() => unknown)>, advertised: readonly string[] = []) {
  const calls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }> = [];
  const client = {
    connection: () => 'connected' as const,
    callReadTool: async (serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push({ serverId, toolName, args: { ...args } });
      if (!(toolName in answers)) throw new Error('fake server: unknown tool ' + toolName);
      const answer = answers[toolName];
      return typeof answer === 'function' ? (answer as () => unknown)() : answer;
    },
    /** The server's advertisement. Data only: it never extends a connector's allowlist. */
    advertisedTools: () => [...advertised],
  };
  return { calls, client };
}

export const FUNDAMENTALS_RAW = {
  period: '2025-Q4',
  currency: 'USD',
  publishedAt: '2026-02-01T00:00:00.000Z',
  effectiveAt: '2025-12-31T00:00:00.000Z',
  revenue: '1000.50',
  grossProfit: '400.25',
  operatingIncome: '150.00',
  ebit: '150.00',
  netIncome: '120.25',
  eps: '1.23',
  cash: '50.00',
  debt: '75.00',
  equity: '300.00',
  operatingCashFlow: '130.00',
  capex: '20.00',
};

export const NEWS_RAW = {
  articleId: 'a-1',
  publisher: 'Example Wire',
  publishedAt: '2026-05-30T08:00:00.000Z',
  url: 'https://news.example.invalid/a-1',
  headline: 'Apple reports quarterly results',
};

export const PORTFOLIO_RAW = {
  asOf: '2026-05-31T21:00:00.000Z',
  currency: 'USD',
  cash: '100.00',
  positions: [{ providerSymbol: 'AAPL', quantity: '10', marketValue: '2000.00', currency: 'USD' }],
};
