import { describe, expect, it } from 'vitest';
import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import { McpFinancialConnector } from '../../src/financial/mcp-transport.js';
import { FinancialGatewayError } from '../../src/financial/financial-types.js';
import { AAPL_ID, change, FUNDAMENTALS_RAW, fakeMcp, instrumentRegistry, PORTFOLIO_RAW, PROVIDER, RESEARCH_ONLY, T0 } from './fixtures.js';

// docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §9, §17, §18. The MCP transport is transport only: a static allowlist decides every tool, write tools are
// refused at construction, and the server's advertisement is data that can never widen the allowlist. Every call goes through the public gateway.

const clock = () => new Date(T0);
const map = (_capability: string, raw: unknown) => ({ candidate: raw, providerSymbol: 'AAPL' });

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function mcpConnector(tools: Record<string, string>, answers: Record<string, unknown>, advertised: string[] = []) {
  const fake = fakeMcp(answers, advertised);
  const connector = new McpFinancialConnector({ connectorId: 'mcp-1', provider: PROVIDER, serverId: 'srv-1', client: fake.client, tools: tools as never, map, clock });
  return { connector, calls: fake.calls };
}

async function gatewayWith(capabilities: string[], connector: McpFinancialConnector) {
  const registry = await FinancialConnectorRegistry.open();
  await registry.register({ connectorId: 'mcp-1', provider: PROVIDER, transport: 'mcp', capabilities: capabilities as never, license: RESEARCH_ONLY, mode: 'RESEARCH' }, change());
  await registry.enable('mcp-1', change());
  return new FinancialDataGateway({ registry, instruments: await instrumentRegistry(), connectors: [connector], clock });
}

const request = (capability: 'news' | 'fundamentals' | 'portfolio_read', requestId = 'r-mcp') => ({
  requestId,
  capability,
  connectorId: 'mcp-1',
  asOf: T0,
  environment: 'research',
  ...(capability === 'portfolio_read' ? {} : { instrumentId: AAPL_ID }),
  ...(capability === 'fundamentals' ? { currency: 'USD', period: '2025-Q4' } : {}),
});

describe('MCP allowlist (§9, §17)', () => {
  it('a capability the registry allows but the server map does not name is refused, and no tool is called', async () => {
    const { connector, calls } = mcpConnector({ fundamentals: 'get_company_fundamentals' }, { get_company_fundamentals: FUNDAMENTALS_RAW }, ['search_company_news']);
    const gateway = await gatewayWith(['fundamentals', 'news'], connector);
    await expect(gateway.fetch(request('news'))).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
    expect(calls).toHaveLength(0);
  });

  it('a write tool named in the map is refused at construction, whatever the capability', () => {
    for (const bad of ['submit_order', 'place_order', 'modify_order', 'cancel_order', 'buy', 'sell', 'transfer_funds', 'withdraw', 'change_position']) {
      const err = thrownBy(() => new McpFinancialConnector({ connectorId: 'mcp-1', provider: PROVIDER, serverId: 'srv-1', client: fakeMcp({}).client, tools: { portfolio_read: bad } as never, map, clock }));
      expect(err, bad).toBeInstanceOf(FinancialGatewayError);
      expect(err, bad).toMatchObject({ code: 'WRITE_TOOL_REFUSED' });
    }
  });

  it('a write name written as one run-together word is refused too (placeorder, transferfunds)', () => {
    for (const bad of ['placeorder', 'submitorder', 'cancelorder', 'buyorder', 'transferfunds']) {
      const err = thrownBy(() => new McpFinancialConnector({ connectorId: 'mcp-1', provider: PROVIDER, serverId: 'srv-1', client: fakeMcp({}).client, tools: { portfolio_read: bad } as never, map, clock }));
      expect(err, bad).toBeInstanceOf(FinancialGatewayError);
      expect(err, bad).toMatchObject({ code: 'WRITE_TOOL_REFUSED' });
    }
  });

  it('a read name that merely contains position or order words stays allowed', () => {
    const err = thrownBy(() => new McpFinancialConnector({ connectorId: 'mcp-1', provider: PROVIDER, serverId: 'srv-1', client: fakeMcp({}).client, tools: { portfolio_read: 'get_open_positions' } as never, map, clock }));
    expect(err).toBeUndefined();
  });

  it('a write tool the server advertises is never called; a portfolio read calls only its read tool', async () => {
    const { connector, calls } = mcpConnector({ portfolio_read: 'get_positions' }, { get_positions: PORTFOLIO_RAW }, ['get_positions', 'submit_order']);
    const gateway = await gatewayWith(['portfolio_read'], connector);
    const e = await gateway.fetch(request('portfolio_read'));
    expect(e.capability).toBe('portfolio_read');
    expect(calls.map((c) => c.toolName)).toEqual(['get_positions']);
  });

  it('the arguments sent to a read tool carry no order, transfer or withdrawal intent', async () => {
    const { connector, calls } = mcpConnector({ fundamentals: 'get_company_fundamentals' }, { get_company_fundamentals: FUNDAMENTALS_RAW });
    const gateway = await gatewayWith(['fundamentals'], connector);
    await gateway.fetch(request('fundamentals'));
    expect(calls).toHaveLength(1);
    for (const key of Object.keys(calls[0]!.args)) {
      expect(key, key).not.toMatch(/order|transfer|withdraw|side|buy|sell|cancel|modify/i);
    }
  });
});
